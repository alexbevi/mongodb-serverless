import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { closeBenchmarkClients, getBenchmarkVariant, measureBenchmark } from './handler-base.js';

const [variant, operation] = process.argv.slice(2);

assert.ok(variant, 'Missing benchmark variant');

assert.ok(operation === 'read' || operation === 'write', 'Unknown benchmark operation');

process.env.BENCHMARK_VARIANT = variant;

getBenchmarkVariant();

process.env.__MONGODB_CLUSTER_TOPOLOGY = await readFile('/tmp/benchmark-topology.json', 'utf8');

const { handler } = operation === 'read' ? await import('./handler-read.js') : await import('./handler-write.js');

try {
  console.log(JSON.stringify(await measureBenchmark(operation, handler)));
} finally {
  await closeBenchmarkClients();
}
