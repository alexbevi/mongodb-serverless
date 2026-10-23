import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildExamples } from './build.js';
import { endpoints, template } from './infrastructure.js';

const run = promisify(execFile);

const exampleDirectory = dirname(fileURLToPath(import.meta.url));

interface Options {
  profile: string;
  region: string;
  stack: string;
  connectionStringParameter: string;
  topologyParameter: string;
  database: string;
  collection: string;
}

export async function deploy(options: Options): Promise<string> {
  const outputDirectory = join(exampleDirectory, 'dist');
  const templateFile = join(outputDirectory, 'template.json');

  await buildExamples(outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(templateFile, `${JSON.stringify(template, null, 2)}\n`);

  await aws(options, [
    'cloudformation', 'deploy',
    '--stack-name', options.stack,
    '--template-file', templateFile,
    '--capabilities', 'CAPABILITY_IAM',
    '--no-fail-on-empty-changeset',
    '--parameter-overrides',
    `ConnectionStringParameterName=${options.connectionStringParameter}`,
    `TopologyParameterName=${options.topologyParameter}`,
    `DatabaseName=${options.database}`,
    `CollectionName=${options.collection}`
  ]);

  for (const endpoint of endpoints) {
    await aws(options, [
      'lambda', 'update-function-code',
      '--function-name', endpoint.functionName,
      '--zip-file', `fileb://${join(outputDirectory, `${endpoint.bundle}.zip`)}`
    ]);
  }

  for (const endpoint of endpoints) {
    await aws(options, [
      'lambda', 'wait', 'function-updated-v2', '--function-name', endpoint.functionName
    ]);
  }

  return aws(options, [
    'cloudformation', 'describe-stacks', '--stack-name', options.stack,
    '--query', "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]", '--output', 'text'
  ]);
}

async function aws(options: Pick<Options, 'profile' | 'region'>, args: string[]): Promise<string> {
  const result = await run('aws', [
    ...args, '--profile', options.profile, '--region', options.region, '--no-cli-pager'
  ], { maxBuffer: 10 * 1024 * 1024 });

  return result.stdout.trim();
}

function options(arguments_: string[]): Options {
  const value = (name: string, fallback: string): string => {
    const index = arguments_.indexOf(name);

    return index === -1 ? fallback : arguments_[index + 1] ?? fallback;
  };

  return {
    profile: value('--profile', process.env.AWS_PROFILE ?? 'personal'),
    region: value('--region', process.env.AWS_REGION ?? 'ap-southeast-2'),
    stack: value('--stack', 'mongodb-serverless-examples'),
    connectionStringParameter: value('--connection-string-parameter', '/mongodb-serverless-pattern/uri'),
    topologyParameter: value('--topology-parameter', '/mongodb-serverless-examples/topology'),
    database: value('--database', 'bench'),
    collection: value('--collection', 'serverless_patterns')
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apiUrl = await deploy(options(process.argv.slice(2)));

  process.stdout.write(`Deployed ${apiUrl}\n`);
}
