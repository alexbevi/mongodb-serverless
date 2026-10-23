import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { endpoints, type Endpoint } from './infrastructure.js';
import type { BuildManifest } from './build.js';

const run = promisify(execFile);

const exampleDirectory = dirname(fileURLToPath(import.meta.url));

interface Timing {
  coldStart?: boolean;
  ssmMs: number;
  connectMs: number;
  operationMs: number;
}

interface ApiResult {
  timing?: Timing;
  error?: string;
}

export interface TimingSummary {
  samples: number;
  ssmMeanMs: number;
  connectMeanMs: number;
  operationMeanMs: number;
  totalMeanMs: number;
  totalMedianMs: number;
  totalStandardDeviationMs: number;
  totalP95Ms: number;
}

export interface ResultRow {
  variant: string;
  operation: string;
  temperature: 'cold' | 'warm';
  packageBytes: number;
  summary: TimingSummary;
}

interface Options {
  profile: string;
  region: string;
  stack: string;
  samples: number;
  output: string;
}

interface StackDetails {
  apiUrl: string;
  apiKeyId: string;
}

interface TemperatureSamples {
  cold: Timing[];
  warm: Timing[];
}

export function summarize(samples: Array<Pick<Timing, 'ssmMs' | 'connectMs' | 'operationMs'>>): TimingSummary {
  if (samples.length === 0) throw new Error('At least one timing sample is required');

  const ssm = samples.map(sample => sample.ssmMs);
  const connect = samples.map(sample => sample.connectMs);
  const operation = samples.map(sample => sample.operationMs);

  const totals = samples
    .map(sample => sample.ssmMs + sample.connectMs + sample.operationMs)
    .sort((left, right) => left - right);

  const totalMean = mean(totals);
  const variance = mean(totals.map(value => (value - totalMean) ** 2));

  return {
    samples: samples.length,
    ssmMeanMs: round(mean(ssm)),
    connectMeanMs: round(mean(connect)),
    operationMeanMs: round(mean(operation)),
    totalMeanMs: round(totalMean),
    totalMedianMs: round(percentile(totals, 0.5)),
    totalStandardDeviationMs: round(Math.sqrt(variance)),
    totalP95Ms: round(percentile(totals, 0.95))
  };
}

export function table(rows: ResultRow[]): string {
  const header = [
    '| Driver | Operation | Run | SSM mean ms | Connect mean ms | Operation mean ms | Total mean ms | Total SD ms | Total p95 ms | ZIP KiB | n |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  const body = rows.map(row => [
    `| ${row.variant}`,
    row.operation,
    row.temperature,
    fixed(row.summary.ssmMeanMs),
    fixed(row.summary.connectMeanMs),
    fixed(row.summary.operationMeanMs),
    fixed(row.summary.totalMeanMs),
    fixed(row.summary.totalStandardDeviationMs),
    fixed(row.summary.totalP95Ms),
    fixed(row.packageBytes / 1024),
    `${row.summary.samples} |`
  ].join(' | '));

  return [...header, ...body].join('\n');
}

export async function measure(options: Options): Promise<ResultRow[]> {
  const stack = await stackDetails(options);

  const apiKey = await aws(options, [
    'apigateway', 'get-api-key', '--api-key', stack.apiKeyId, '--include-value',
    '--query', 'value', '--output', 'text'
  ]);

  const manifest: BuildManifest = JSON.parse(
    await readFile(join(exampleDirectory, 'dist/manifest.json'), 'utf8')
  );

  const packageSizes = new Map(manifest.bundles.map(bundle => [bundle.name, bundle.zipBytes]));
  const seedEndpoint = endpoints.find(endpoint => endpoint.bundle === 'aws-ssm-save');

  if (!seedEndpoint) throw new Error('The aws-ssm save endpoint is required to seed the topology');

  await invoke(stack.apiUrl, apiKey, seedEndpoint, 'seed');

  const measurements = new Map<string, TemperatureSamples>(
    endpoints.map(endpoint => [endpoint.bundle, { cold: [], warm: [] }])
  );

  for (let index = 0; index < options.samples; index += 1) {
    await Promise.all(endpoints.map(async endpoint => {
      const samples = measurements.get(endpoint.bundle);

      if (!samples) throw new Error(`Missing measurements for ${endpoint.bundle}`);

      await forceColdStart(options, endpoint.functionName);

      const cold = await invoke(stack.apiUrl, apiKey, endpoint, `${endpoint.bundle}-${index}`);
      const warm = await invoke(stack.apiUrl, apiKey, endpoint, `${endpoint.bundle}-${index}`);

      assertTemperature(cold, true, endpoint);
      assertTemperature(warm, false, endpoint);
      samples.cold.push(cold);
      samples.warm.push(warm);
    }));
  }

  return endpoints.flatMap(endpoint => {
    const samples = measurements.get(endpoint.bundle);
    const packageBytes = packageSizes.get(endpoint.bundle);

    if (!samples) throw new Error(`Missing measurements for ${endpoint.bundle}`);

    if (packageBytes === undefined) throw new Error(`Missing package size for ${endpoint.bundle}`);

    const temperatures: Array<{ temperature: 'cold' | 'warm'; timings: Timing[] }> = [
      { temperature: 'cold', timings: samples.cold },
      { temperature: 'warm', timings: samples.warm }
    ];

    return temperatures.map(result => ({
      variant: endpoint.variant,
      operation: endpoint.operation,
      temperature: result.temperature,
      packageBytes,
      summary: summarize(result.timings)
    }));
  });
}

async function stackDetails(options: Options): Promise<StackDetails> {
  const text = await aws(options, [
    'cloudformation', 'describe-stacks', '--stack-name', options.stack,
    '--query', 'Stacks[0].Outputs', '--output', 'json'
  ]);

  const outputs: Array<{ OutputKey: string; OutputValue: string }> = JSON.parse(text);
  const value = (key: string) => outputs.find(output => output.OutputKey === key)?.OutputValue;
  const apiUrl = value('ApiUrl');
  const apiKeyId = value('ApiKeyId');

  if (!apiUrl || !apiKeyId) throw new Error(`Stack ${options.stack} has no example API outputs`);

  return { apiUrl, apiKeyId };
}

async function forceColdStart(options: Options, functionName: string): Promise<void> {
  const text = await aws(options, [
    'lambda', 'get-function-configuration', '--function-name', functionName,
    '--query', 'Environment.Variables', '--output', 'json'
  ]);

  const variables: Record<string, string> = JSON.parse(text);

  await aws(options, [
    'lambda', 'update-function-configuration', '--function-name', functionName,
    '--environment', JSON.stringify({ Variables: { ...variables, COLD_NONCE: randomUUID() } })
  ]);
  await aws(options, [
    'lambda', 'wait', 'function-updated-v2', '--function-name', functionName
  ]);
}

async function invoke(
  apiUrl: string,
  apiKey: string,
  endpoint: Endpoint,
  value: string
): Promise<Timing> {
  const url = `${apiUrl}/${endpoint.variant}/${endpoint.operation}${endpoint.operation === 'find' ? '?id=example' : ''}`;

  const request: RequestInit = {
    method: endpoint.method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey
    }
  };

  if (endpoint.operation === 'save') request.body = JSON.stringify({ id: 'example', value });

  const response = await fetch(url, request);

  const result: ApiResult = JSON.parse(await response.text());

  if (!response.ok || !result.timing) {
    throw new Error(`${endpoint.method} ${endpoint.variant}/${endpoint.operation} failed: ${result.error ?? response.status}`);
  }

  return result.timing;
}

function assertTemperature(timing: Timing, cold: boolean, endpoint: Endpoint): void {
  if (timing.coldStart !== cold) {
    throw new Error(`${endpoint.bundle} reported coldStart=${String(timing.coldStart)}; expected ${String(cold)}`);
  }
}

async function aws(options: Pick<Options, 'profile' | 'region'>, args: string[]): Promise<string> {
  const result = await run('aws', [
    ...args, '--profile', options.profile, '--region', options.region, '--no-cli-pager'
  ], { maxBuffer: 10 * 1024 * 1024 });

  return result.stdout.trim();
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(sorted: number[], fraction: number): number {
  const rank = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  const value = sorted[rank];

  if (value === undefined) throw new Error('Cannot calculate a percentile without values');

  return value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fixed(value: number): string {
  return value.toFixed(1);
}

function options(arguments_: string[]): Options {
  const value = (name: string, fallback: string): string => {
    const index = arguments_.indexOf(name);

    return index === -1 ? fallback : arguments_[index + 1] ?? fallback;
  };

  const samples = Number.parseInt(value('--samples', '20'), 10);

  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer');

  return {
    profile: value('--profile', process.env.AWS_PROFILE ?? 'personal'),
    region: value('--region', process.env.AWS_REGION ?? 'ap-southeast-2'),
    stack: value('--stack', 'mongodb-serverless-examples'),
    samples,
    output: resolve(value('--output', join(tmpdir(), 'mongodb-serverless-aws-results.json')))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = options(process.argv.slice(2));
  const rows = await measure(settings);

  const report = {
    measuredAt: new Date().toISOString(),
    region: settings.region,
    stack: settings.stack,
    scope: 'Handler connection and operation time; excludes Lambda INIT and caller/API latency',
    rows
  };

  await writeFile(settings.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${table(rows)}\n\nResults: ${settings.output}\n`);
}
