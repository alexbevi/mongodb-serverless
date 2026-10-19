import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LambdaClient, CreateFunctionCommand, waitUntilFunctionActiveV2, PublishVersionCommand } from '@aws-sdk/client-lambda';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { collect, invokeCold, workerPatterns } from './lambda-collect.mjs';

const { values } = parseArgs({ options: { samples: { type: 'string', default: '40' }, output: { type: 'string', default: 'benchmark/results/local/samples.json' }, package: { type: 'string', default: '/tmp/mongodb-pattern-runtime/worker' } } });

const count = Number(values.samples);

if (!Number.isInteger(count) || count < 1) throw new Error('Invalid sample count');

const compose = (...args) => execFileSync('docker', ['compose', '-f', 'benchmark/docker/compose.yaml', '-f', 'benchmark/docker/lambda-compose.yaml', ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 600000, maxBuffer: 20 * 1024 * 1024 });

const inside = (service, ...args) => compose('exec', '-T', service, ...args);

const mongo = source => inside('mongo-a', 'mongosh', '--quiet', '--tls', '--tlsCAFile', '/certs/ca.crt', '--eval', source);

async function ready(action) {
  let failure;

  for (let attempt = 0; attempt < 90; attempt += 1) {
    try { return await action(); } catch (error) { failure = error; }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw failure;
}

const endpoint = 'http://127.0.0.1:4566';

const clientOptions = { region: 'ap-southeast-2', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 };

const lambda = new LambdaClient(clientOptions);

const ssm = new SSMClient(clientOptions);

const prefix = 'mongodb-pattern';

const uriParameter = '/mongodb-pattern/uri';

const topologyParameter = '/mongodb-pattern/topology';

const directory = resolve(values.package);

try {
  compose('build');
  compose('run', '--rm', '--no-deps', 'certificates');
  compose('up', '-d', 'mongo-a', 'mongo-b', 'mongo-c', 'dns', 'client', 'localstack');
  await ready(() => mongo('if (db.adminCommand({ping:1}).ok !== 1) throw Error("not ready")'));
  mongo('rs.initiate({_id:"benchmark",members:[{_id:0,host:"mongo-a.bench.test:27017",priority:10},{_id:1,host:"mongo-b.bench.test:27017",priority:0},{_id:2,host:"mongo-c.bench.test:27017",priority:0}]})');
  await ready(() => mongo('if (!db.hello().isWritablePrimary) throw Error("not primary")'));
  mongo('db.getSiblingDB("admin").createUser({user:"bench",pwd:"benchmark-only",roles:["root"]})');
  await ready(() => inside('client', 'node', 'benchmark/dist/setup.js'));
  compose('cp', 'client:/certs/ca.crt', `${directory}/ca.crt`);
  execFileSync('zip', ['-q', '../lambda-worker.zip', 'ca.crt'], { cwd: directory });
  await ready(() => ssm.send(new PutParameterCommand({ Name: uriParameter, Type: 'SecureString', Value: 'mongodb+srv://bench:benchmark-only@cluster.bench.test/bench?authSource=admin', Overwrite: true })));
  const zip = readFileSync(resolve(directory, '../lambda-worker.zip'));
  const variables = { URI_PARAMETER: uriParameter, TOPOLOGY_PARAMETER: topologyParameter, DATABASE: 'bench', MONGODB_CA: '/var/task/ca.crt', BENCHMARK_DNS: '172.30.91.14', SSM_ENDPOINT: 'http://localstack:4566' };

  for (const { name, variant } of workerPatterns(prefix)) {
    await lambda.send(new CreateFunctionCommand({ FunctionName: name, Role: 'arn:aws:iam::000000000000:role/benchmark', Runtime: 'nodejs24.x', Handler: 'benchmark/dist/lambda-worker.handler', Architectures: [process.arch === 'arm64' ? 'arm64' : 'x86_64'], MemorySize: 1769, Timeout: 30, Code: { ZipFile: zip }, Environment: { Variables: { ...variables, BENCHMARK_VARIANT: variant } } }));
    await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120, minDelay: 1, maxDelay: 2 }, { FunctionName: name });
  }

  const preparationVersion = await lambda.send(new PublishVersionCommand({ FunctionName: `${prefix}-ssm-write` }));
  const preparation = await invokeCold(lambda, `${prefix}-ssm-write`, preparationVersion.Version, { variant: 'ssm', operation: 'write', prepare: true });
  await collect(lambda, prefix, count, resolve(values.output), { environment: 'LocalStack 4.14.0', packageSha256: createHash('sha256').update(zip).digest('hex'), memoryMB: 1769, current: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), preparation, diagnostics: true });
} finally {
  lambda.destroy();
  ssm.destroy();
  compose('down', '--volumes', '--remove-orphans');
}
