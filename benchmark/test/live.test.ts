import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { instrument } from '../instrument.js';
import type { breakdown, lifecycleWindows } from '../metrics.js';
import type { SocketTrace, LifecycleEvent } from '../types.js';

interface BenchmarkResult {
  environment: { cpuMax: string; memoryMax: string };
  samples: {
    iteration: number;
    variant: string;
    operation: string;
    servedRole: string;
    seedOrder?: string[];
    verified: boolean;
    processId: number;
    driverVersion: string;
    applicationConnectionReadyMs: number;
    commandStartedMs: number;
    readyToCommandMs: number;
    address: string;
    connections: ReturnType<ReturnType<typeof instrument>['connections']>;
    trace: { events: LifecycleEvent[]; lifecycle: ReturnType<typeof lifecycleWindows>; sockets: SocketTrace[]; command: { name: string; socket: { authMechanism: string } } };
    timings: ReturnType<typeof breakdown>;
  }[];
  network: { source: string; target: string; measuredRttMs: number; configuredRttMs: number }[];
}

test('compares fresh clients against a delayed TLS replica set with SCRAM authentication', () => {
  const output = join(mkdtempSync(join(tmpdir(), 'mongo-benchmark-')), 'results.json');
  execFileSync('npm', ['run', 'benchmark', '--', '--no-monitoring', '--samples', '12', '--output', output], { stdio: 'inherit', timeout: 580_000 });
  const result: BenchmarkResult = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.samples.length, 72);
  assert.equal(result.environment.memoryMax, '1073741824');
  const [quota, period] = result.environment.cpuMax.split(' ').map(Number);
  assert.ok(Math.abs(quota! / period! - 1024 / 1769) < 0.001);

  for (const sample of result.samples) {
    assert.ok(sample.verified);
    assert.ok(sample.trace.lifecycle.connectionSetup[1] > sample.trace.lifecycle.connectionSetup[0]);
    assert.ok(sample.trace.lifecycle.checkouts.length > 0);
    assert.ok(sample.trace.lifecycle.command[1] > sample.trace.lifecycle.command[0]);
    assert.ok(sample.trace.events.every(event => event.name !== 'commandFailed' && event.name !== 'connectionCheckOutFailed'));
    assert.equal(sample.trace.events.filter(event => event.name === 'commandSucceeded').length, 1);
    assert.ok(sample.applicationConnectionReadyMs > 0, 'Record readiness of the connection serving the operation');
    assert.ok(sample.commandStartedMs >= sample.applicationConnectionReadyMs);
    assert.ok(sample.commandStartedMs < sample.timings.total);
    assert.equal(sample.readyToCommandMs, sample.commandStartedMs - sample.applicationConnectionReadyMs);
    assert.equal(sample.trace.sockets.filter(socket => socket.auth).length, 1, 'First operation must not preconnect to another member');
    assert.equal(sample.trace.command.name, sample.operation === 'read' ? 'find' : 'update');
    assert.equal(sample.trace.command.socket.authMechanism, 'SCRAM-SHA-1');

    if (sample.variant === 'serverless-no-monitoring') {
      assert.equal(sample.trace.sockets.length, 1);
      assert.ok(sample.trace.sockets[0]!.auth);
      assert.ok(sample.trace.sockets[0]!.hello);
    } else if (sample.variant === 'serverless') {
      assert.equal(sample.trace.sockets.length, 2);
      assert.equal(sample.trace.sockets.filter(socket => socket.auth).length, 1);
    }

    assert.equal(sample.connections.length, 1);
    const connection = sample.connections[0];
    assert.ok(connection);
    const target = sample.operation === 'read' ? 'mongo-b' : 'mongo-a';

    if (sample.operation === 'read' && sample.variant === 'native') assert.ok(['SECONDARY', 'PRIMARY'].includes(sample.servedRole));
    else assert.equal(sample.servedRole, sample.operation === 'read' ? 'SECONDARY' : 'PRIMARY');

    if (sample.variant !== 'native') {
      assert.equal(sample.seedOrder, undefined);
      assert.equal(connection.directConnection, true);
      assert.deepEqual(connection.hosts, [`${target}.bench.test:27017`]);
      assert.equal(connection.replicaSet, null);
      assert.equal(connection.topologyType, 'Single');
      assert.deepEqual(connection.servers, [`${target}.bench.test:27017`]);
      assert.match(connection.uri, /directConnection=true/);
      assert.ok(!connection.uri.includes('replicaSet='));
      assert.deepEqual([...new Set(sample.trace.sockets.map(socket => socket.host))], [`${target}.bench.test`]);
    } else {
      assert.match(connection.uri, /^mongodb\+srv:/);
      assert.equal(connection.directConnection, false);
      assert.deepEqual([...connection.hosts].sort(), ['mongo-a.bench.test:27017','mongo-b.bench.test:27017','mongo-c.bench.test:27017']);
      assert.equal(connection.replicaSet, 'benchmark');
      assert.ok(['ReplicaSetWithPrimary', 'ReplicaSetNoPrimary'].includes(connection.topologyType));
    }

    assert.ok(!connection.uri.includes('benchmark-only'));

    for (const phase of ['tcp', 'tls', 'hello', 'auth', 'send', 'receive'] as const) assert.ok(sample.timings[phase] > 0, phase);
    assert.ok(sample.timings.other >= 0);
    assert.equal(sample.driverVersion, '7.7.0');
    assert.match(sample.address, sample.operation === 'read' && sample.variant === 'native' ? /172\.30\.91\.1[123]:27017/ : sample.operation === 'read' ? /172\.30\.91\.12:27017/ : /172\.30\.91\.11:27017/);
  }

  assert.equal(new Set(result.samples.map(s => s.processId)).size, 72);
  assert.equal(result.network.length, 12);
  const readLink = result.network.find(link => link.source === 'client' && link.target === 'mongo-b')!;
  const writeLink = result.network.find(link => link.source === 'client' && link.target === 'mongo-a')!;
  assert.ok(readLink.configuredRttMs < writeLink.configuredRttMs, 'Model the measured AWS ordering: a secondary is closer than the primary');
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
