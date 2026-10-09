import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { instrument } from '../instrument.js';
import type { breakdown } from '../metrics.js';
import type { SocketTrace } from '../types.js';

interface BenchmarkResult {
  samples: {
    iteration: number;
    variant: string;
    seedOrder?: string[];
    verified: boolean;
    processId: number;
    driverVersion: string;
    address: string;
    connections: ReturnType<ReturnType<typeof instrument>['connections']>;
    trace: { sockets: SocketTrace[] };
    timings: ReturnType<typeof breakdown>;
  }[];
  network: { measuredRttMs: number; configuredRttMs: number }[];
}

test('compares fresh clients against a delayed TLS replica set with SCRAM authentication', () => {
  const output = join(mkdtempSync(join(tmpdir(), 'mongo-benchmark-')), 'results.json');
  execFileSync('npm', ['run', 'benchmark', '--', '--samples', '12', '--output', output], { stdio: 'inherit', timeout: 580_000 });
  const result: BenchmarkResult = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.samples.length, 48);
  for (const sample of result.samples) {
    assert.ok(sample.verified);
    assert.equal(sample.connections.length, 1);
    const connection = sample.connections[0];
    assert.ok(connection);
    if (sample.variant === 'serverless') {
      assert.equal(sample.seedOrder, undefined);
      assert.equal(connection.directConnection, true);
      assert.deepEqual(connection.hosts, ['mongo-a:27017']);
      assert.equal(connection.replicaSet, null);
      assert.equal(connection.topologyType, 'Single');
      assert.deepEqual(connection.servers, ['mongo-a:27017']);
      assert.match(connection.uri, /directConnection=true/);
      assert.ok(!connection.uri.includes('replicaSet='));
      assert.deepEqual([...new Set(sample.trace.sockets.map(socket => socket.host))], ['mongo-a']);
    } else {
      assert.ok(sample.seedOrder);
      assert.equal(sample.seedOrder.length, 3);
      assert.deepEqual([...sample.seedOrder].sort(), ['mongo-a:27017', 'mongo-b:27017', 'mongo-c:27017']);
      assert.equal(connection.directConnection, false);
      assert.deepEqual(connection.hosts, sample.seedOrder);
      assert.deepEqual(sample.trace.sockets.slice(0, 3).map(socket => socket.host),
        sample.seedOrder.map(host => host.split(':')[0]));
      assert.equal(connection.replicaSet, 'benchmark');
      assert.equal(connection.topologyType, 'ReplicaSetWithPrimary');
    }
    assert.ok(!connection.uri.includes('benchmark-only'));
    for (const phase of ['tcp', 'tls', 'hello', 'auth', 'send', 'receive'] as const) assert.ok(sample.timings[phase] > 0, phase);
    assert.ok(sample.timings.other >= 0);
    assert.equal(sample.driverVersion, '7.7.0');
    assert.match(sample.address, /172\.30\.91\.11:27017/);
  }
  assert.equal(new Set(result.samples.map(s => s.processId)).size, 48);
  const orders = new Map<string, string[]>();
  for (let iteration = 0; iteration < 12; iteration++) {
    const pair = result.samples.filter(sample => sample.iteration === iteration);
    assert.equal(pair.length, 4);
    const native = pair.filter(sample => sample.variant === 'native');
    assert.equal(native.length, 2);
    assert.ok(native[0]?.seedOrder);
    assert.deepEqual(native[0].seedOrder, native[1]!.seedOrder);
    const key = native[0].seedOrder.join(',');
    if (!orders.has(key)) orders.set(key, []);
    orders.get(key)!.push(pair[0]!.variant);
  }
  assert.equal(orders.size, 6);
  for (const firstVariants of orders.values()) assert.deepEqual(firstVariants.sort(), ['native', 'serverless']);
  assert.equal(result.network.length, 12);
  assert.ok(result.network.every(link => link.measuredRttMs >= link.configuredRttMs * 0.8));
  const ownership = 'label=com.docker.compose.project=mongodb-latency-benchmark';
  for (const args of [
    ['container', 'ls', '-aq'],
    ['image', 'ls', '-aq'],
    ['volume', 'ls', '-q'],
    ['network', 'ls', '-q'],
  ]) {
    assert.equal(execFileSync('docker', [...args, '--filter', ownership], { encoding: 'utf8' }).trim(), '',
      `Benchmark left Docker resources behind: ${args.join(' ')}`);
  }
}, 600_000);
