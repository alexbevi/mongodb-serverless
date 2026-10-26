/**
 * Measures cold operations against a TLS replica set in Docker.
 *
 * Each sample is a fresh Node process running the same handler the AWS benchmark
 * deploys. netem adds network round trips and LocalStack serves SSM.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DeleteParametersCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { assertWarmReuse, topologyParameterFor, variants, workerPatterns, writeSamples } from './lambda-collect.mjs';

const { values } = parseArgs({ options: {
  samples: { type: 'string', default: '40' },
  output: { type: 'string', default: 'benchmark/results/local/samples.json.gz' },
  // A Lambda outside a VPC reaches every Atlas member at about the same
  // latency; AWS TCP connects take 1.2–1.3 ms to every member.
  rtt: { type: 'string', default: '1.3' }
} });

const count = Number(values.samples);

const rtt = Number(values.rtt);

if (!Number.isInteger(count) || count < 1) throw new Error('--samples must be a positive integer');

if (!Number.isFinite(rtt) || rtt <= 0) throw new Error('--rtt must be a positive number of milliseconds');

const compose = (...args) => execFileSync('docker', ['compose', '-f', 'benchmark/docker/compose.yaml', ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });

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

const prefix = 'mongodb-pattern';

const uriParameter = `/${prefix}/uri`;

const ssm = new SSMClient({ region: 'ap-southeast-2', endpoint: 'http://127.0.0.1:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });

/** Runs the handler in a new process inside the client container. */
function run(variant, operation, topologyParameter, { warm = false, prepare = false } = {}) {
  const variables = { BENCHMARK_VARIANT: variant, URI_PARAMETER: uriParameter, TOPOLOGY_PARAMETER: topologyParameter, DATABASE: 'bench',
    MONGODB_CA: '/certs/ca.crt', SSM_ENDPOINT: 'http://localstack:4566', AWS_REGION: 'ap-southeast-2',
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' };

  const event = JSON.stringify(prepare ? { variant, operation, prepare } : { variant, operation });

  const output = inside('client', 'env', ...Object.entries(variables).map(([key, value]) => `${key}=${value}`),
    'node', 'benchmark/dist/cold.js', event, ...(warm ? ['warm'] : []));

  return JSON.parse(output);
}

/** Adds the same round-trip delay between every pair of containers. */
function addNetworkLatency() {
  const nodes = [{ name: 'client', ip: '172.30.91.10' }, { name: 'mongo-a', ip: '172.30.91.11' }, { name: 'mongo-b', ip: '172.30.91.12' }, { name: 'mongo-c', ip: '172.30.91.13' }];
  const network = [];

  for (const source of nodes) {
    inside(source.name, 'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'handle', '1:', 'prio', 'bands', '4', 'priomap', ...Array(16).fill('3'));
    let band = 1;

    for (const target of nodes.filter(node => node !== source)) {
      inside(source.name, 'tc', 'qdisc', 'replace', 'dev', 'eth0', 'parent', `1:${band}`, 'handle', `${band + 10}:`, 'netem', 'delay', `${rtt / 2}ms`);
      inside(source.name, 'tc', 'filter', 'add', 'dev', 'eth0', 'protocol', 'ip', 'parent', '1:', 'prio', '1', 'u32', 'match', 'ip', 'dst', `${target.ip}/32`, 'flowid', `1:${band}`);
      network.push({ source: source.name, target: target.name, configuredRttMs: rtt });
      band += 1;
    }
  }

  return network;
}

const file = resolve(values.output);

const started = Date.now();

const samples = [];

const data = { createdAt: new Date(started).toISOString(), configuration: { count, variants, environment: 'Local Docker', rttMs: rtt,
  readPreference: 'nearest', writes: 'primary / majority', timing: 'SSM fetched during process startup; handler through result', overview: 'handler' }, samples, failures: [] };

const save = () => writeSamples(file, JSON.stringify({ ...data, elapsedMs: Date.now() - started }, null, 2) + '\n');

try {
  compose('build');
  compose('run', '--rm', '--no-deps', 'certificates');
  compose('up', '-d', 'mongo-a', 'mongo-b', 'mongo-c', 'dns', 'client', 'localstack');
  await ready(() => mongo('if (db.adminCommand({ping:1}).ok !== 1) throw Error("not ready")'));
  mongo('rs.initiate({_id:"benchmark",members:[{_id:0,host:"mongo-a.bench.test:27017",priority:10},{_id:1,host:"mongo-b.bench.test:27017",priority:0},{_id:2,host:"mongo-c.bench.test:27017",priority:0}]})');
  await ready(() => mongo('if (!db.hello().isWritablePrimary) throw Error("not primary")'));
  mongo('db.getSiblingDB("admin").createUser({user:"bench",pwd:"benchmark-only",roles:["root"]})');
  await ready(() => ssm.send(new PutParameterCommand({ Name: uriParameter, Type: 'SecureString', Value: 'mongodb+srv://bench:benchmark-only@cluster.bench.test/bench?authSource=admin', Overwrite: true })));
  data.configuration.network = addNetworkLatency();
  data.configuration.client = { node: inside('client', 'node', '--version').trim() };

  // Stores the seed document and the cached topology the `ssm` pattern reads.
  data.configuration.preparation = run('ssm', 'write', topologyParameterFor(prefix, 'ssm', 'write'), { prepare: true })[0];
  data.configuration.warmVerification = workerPatterns(prefix).map(({ variant, operation }) => {
    const [cold, warm] = run(variant, operation, topologyParameterFor(prefix, variant, operation), { warm: true });
    assertWarmReuse(cold, warm);

    return { variant, operation, verified: true, totalMs: warm.totalMs, servedRole: warm.servedRole, sockets: warm.sockets,
      ssmReads: warm.ssmReads, ssmWrites: warm.ssmWrites, discoveryCommands: warm.discoveryCommands, sameEnvironment: true,
      sameClient: true, sameSocket: warm.trace.command.socket.start === cold.trace.command.socket.start };
  });

  for (let iteration = 0; iteration < count; iteration += 1) {
    const order = variants.map((_, index) => variants[(index + iteration) % variants.length]);

    if (iteration % 2) order.reverse();

    for (const operation of iteration % 2 ? ['write', 'read'] : ['read', 'write']) {
      for (const variant of order) {
        const topologyParameter = topologyParameterFor(prefix, variant, operation);

        try {
          const [sample] = run(variant, operation, topologyParameter);
          assert.ok(sample.cold && sample.verified);
          samples.push({ iteration, batch: Math.min(3, Math.floor(iteration / Math.max(1, count / 4))), ...sample });
        } finally {
          if (variant === 'ssm-uncached') await ssm.send(new DeleteParametersCommand({ Names: [topologyParameter] }));
        }
      }
    }

    save();
  }

  save();
  console.log(`Saved ${samples.length} verified cold samples to ${file}`);
} catch (error) {
  data.failures.push({ name: error.name, message: error.message });
  save();
  const logs = (() => { try { return compose('logs', '--no-color', '--tail', '40'); } catch { return ''; } })();
  console.error(logs);
  throw error;
} finally {
  ssm.destroy();
  compose('down', '--volumes', '--remove-orphans');
}
