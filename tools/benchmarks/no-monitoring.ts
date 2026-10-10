import { summarize } from './statistics.js';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startSecureCluster } from '../../test/harness/secure-cluster.js';
import { startRelay } from '../../test/harness/relay.js';

interface ByMode<T> {
  stock: T;
  polyfill: T;
}

interface Timing {
  connectMS: number;
  firstOperationMS: number;
}

interface Sample extends Timing {
  processToFirstResultMS: number;
  sockets: { accepted: number; peak: number; closed: number; open: number };
}

function isTiming(message: unknown): message is Timing {
  return message !== null && typeof message === 'object' &&
    'connectMS' in message && typeof message.connectMS === 'number' &&
    'firstOperationMS' in message && typeof message.firstOperationMS === 'number';
}

function isWarm(message: unknown): message is { warmMS: number[] } {
  return message !== null && typeof message === 'object' &&
    'warmMS' in message && Array.isArray(message.warmMS) && message.warmMS.every(isNumber);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const fixture = await startSecureCluster();

const samples: ByMode<Sample[]> = { stock: [], polyfill: [] };

const warm: ByMode<number[]> = { stock: [], polyfill: [] };

async function sample(mode: 'stock' | 'polyfill', warmCount = 0): Promise<Sample> {
  const relay = await startRelay(29400);
  const started = performance.now();

  const child = fork(fileURLToPath(new URL('./no-monitoring-sample.mjs', import.meta.url)), [
    mode, fixture.uri.replace('29400', String(relay.port)), fixture.ca, String(warmCount)
  ], { silent: true, execArgv: [] });

  let timing: Timing | undefined;
  let processToFirstResultMS = 0;
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    if (isTiming(message)) {
      timing = message;
      processToFirstResultMS = performance.now() - started;
    } else if (isWarm(message)) {
      warm[mode] = message.warmMS;
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
    });
  } finally {
    await relay.close();
  }

  if (!timing) throw new Error('Sample exited without timing results');
  const expected = mode === 'stock' ? 2 : 1;

  if (relay.counts.accepted !== expected || relay.counts.closed !== expected || relay.counts.open !== 0) {
    throw new Error(`Unexpected ${mode} socket counts: ${JSON.stringify(relay.counts)}`);
  }

  return { ...timing, processToFirstResultMS, sockets: { ...relay.counts } };
}

for (let index = 0; index < 100; index++) {
  for (const mode of ['stock', 'polyfill'] as const) samples[mode].push(await sample(mode));
}

for (const mode of ['stock', 'polyfill'] as const) await sample(mode, 100);

const summary = Object.fromEntries((['stock', 'polyfill'] as const).map(mode => [mode, {
  connectMS: summarize(samples[mode].map(item => item.connectMS)),
  firstOperationMS: summarize(samples[mode].map(item => item.firstOperationMS)),
  processToFirstResultMS: summarize(samples[mode].map(item => item.processToFirstResultMS)),
  warmOperationMS: summarize(warm[mode]),
  socketsPerColdSample: samples[mode][0]?.sockets
}]));

const report = { measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, samplesPerMode: 100, summary, samples, warm };

await writeFile(new URL('./no-monitoring-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({ node: report.node, platform: report.platform, summary }, null, 2));
