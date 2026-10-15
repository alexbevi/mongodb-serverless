import type { MongoClientOptions, MongoClientEvents, ObjectId, WithId, UpdateResult } from 'mongodb';
import assert from 'node:assert/strict';
import { instrument } from './instrument.js';
import type { LifecycleEvent } from './types.js';
import { breakdown, lifecycleWindows } from './metrics.js';

export type BenchmarkOperation = 'read' | 'write';

export interface BenchmarkDocument {
  _id?: string | ObjectId;
  value?: number;
  payload: string;
}

const telemetry = instrument();

const { MongoClient: NativeClient } = await import('mongodb');

// SAFETY: The runtime URL loads the built workspace driver matching the imported declaration type.
const { MongoClient: ServerlessClient } = await import(new URL('../../driver/dist/driver/src/index.js', import.meta.url).href) as typeof import('../driver/dist/driver/src/index.js');

// SAFETY: The runtime URL loads the built local plugin matching the imported declaration type.
const { LocalPlugin } = await import(new URL('../../plugins/local/dist/local/src/index.js', import.meta.url).href) as typeof import('../plugins/local/dist/local/src/index.js');

const CONNECTION_STRING = 'mongodb+srv://bench:benchmark-only@cluster.bench.test/bench';

const READ_CONNECTION_STRING = 'mongodb://bench:benchmark-only@mongo-b.bench.test:27017/bench?authSource=admin&tls=true&directConnection=true';

const WRITE_CONNECTION_STRING = 'mongodb://bench:benchmark-only@mongo-a.bench.test:27017/bench?authSource=admin&tls=true&directConnection=true';

type BenchmarkClient = InstanceType<typeof NativeClient> | InstanceType<typeof ServerlessClient>;

const clients = new Set<BenchmarkClient>();

export function getBenchmarkVariant() {
  const variant = process.env.BENCHMARK_VARIANT;

  assert.ok(variant === 'native' || variant === 'serverless' || variant === 'serverless-no-monitoring', 'Unknown benchmark variant');

  return variant;
}

const events: LifecycleEvent[] = [];

function record(name: string, event: Omit<LifecycleEvent, 'name' | 'at'> & { duration?: number }) {
  if (event.commandName && event.commandName !== 'find' && event.commandName !== 'update') return;
  const entry: LifecycleEvent = { name, at: performance.now(), address: event.address };

  if (event.connectionId !== undefined) entry.connectionId = event.connectionId;

  if (event.requestId !== undefined) entry.requestId = event.requestId;

  if (event.commandName !== undefined) entry.commandName = event.commandName;

  if (event.reason !== undefined) entry.reason = event.reason;
  const duration = event.durationMS ?? event.duration;

  if (duration !== undefined) entry.durationMS = duration;
  events.push(entry);
}

const on = {
  connectionCreated: event => record('connectionCreated', event),
  connectionReady: event => record('connectionReady', event),
  connectionClosed: event => record('connectionClosed', event),
  connectionCheckOutStarted: event => record('connectionCheckOutStarted', event),
  connectionCheckedOut: event => record('connectionCheckedOut', event),
  connectionCheckedIn: event => record('connectionCheckedIn', event),
  connectionCheckOutFailed: event => record('connectionCheckOutFailed', event),
  commandStarted: event => record('commandStarted', event),
  commandSucceeded: event => record('commandSucceeded', event),
  commandFailed: event => record('commandFailed', event)
} satisfies Partial<MongoClientEvents>;

export function createServerlessMongoClientForBenchmark(operation: BenchmarkOperation) {
  const variant = getBenchmarkVariant();
  const uri = variant === 'native' ? CONNECTION_STRING : operation === 'read' ? READ_CONNECTION_STRING : WRITE_CONNECTION_STRING;
  const options: MongoClientOptions = { monitorCommands: true, authMechanism: 'SCRAM-SHA-1', tlsCAFile: '/certs/ca.crt', maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 10000, retryReads: false, retryWrites: false, writeConcern: { w: 'majority', wtimeoutMS: 10000 } };

  if (operation === 'read') options.readPreference = 'secondaryPreferred';

  const client = variant === 'native'
    ? new NativeClient(uri, options)
    : new ServerlessClient(uri, { ...options, plugin: new LocalPlugin(), on, disableMonitoring: variant === 'serverless-no-monitoring' });

  if (client instanceof NativeClient) {
    for (const [event, listener] of Object.entries(on)) client.on(event, listener);
  }

  clients.add(client);

  return client;
}

export async function measureBenchmark(
  operation: BenchmarkOperation,
  handler: () => Promise<WithId<BenchmarkDocument> | UpdateResult<BenchmarkDocument> | null>
) {
  const variant = getBenchmarkVariant();
  const commandIndex = telemetry.commands.length;
  const eventIndex = events.length;
  const start = performance.now();
  const result = await handler();
  const end = performance.now();

  if (operation === 'read') assert.equal(result && 'payload' in result && result.payload, 'benchmark');
  else assert.equal(result && 'matchedCount' in result && result.matchedCount, 1);
  const command = telemetry.commands.slice(commandIndex).find(c => c.name === (operation === 'read' ? 'find' : 'update'));
  assert.ok(command, 'The operation must produce a measured wire command');
  assert.ok(command.socket.authorized, 'TLS must verify the certificate');

  if (variant === 'native' && operation === 'read') assert.ok(['SECONDARY', 'PRIMARY'].includes(command.socket.role!));
  else assert.equal(command.socket.role, operation === 'read' ? 'SECONDARY' : 'PRIMARY');
  const timings = breakdown(start, end, command.socket, command);
  const lifecycleEvents = events.slice(eventIndex);
  const lifecycle = lifecycleWindows(command, lifecycleEvents, end);
  const connectionReady = lifecycle.connectionSetup[1];
  const commandStarted = lifecycle.command[0];

  const applicationConnectionReadyMs = connectionReady - start;
  const commandStartedMs = commandStarted - start;
  const readyToCommandMs = commandStartedMs - applicationConnectionReadyMs;
  assert.ok(connectionReady >= command.socket.auth![1], 'Readiness must follow authentication');
  assert.ok(readyToCommandMs >= 0 && commandStartedMs < timings.total, 'Invalid operation event order');

  return { variant, operation, processId: process.pid, driverVersion: telemetry.version, nodeVersion: process.version, address: command.address, verified: true, servedRole: command.socket.role, connections: telemetry.connections(), timings, applicationConnectionReadyMs, commandStartedMs, readyToCommandMs, trace: { start, end, command, lifecycle, events: lifecycleEvents, sockets: [...telemetry.traces] } };
}

export async function closeBenchmarkClients() {
  await Promise.all([...clients].map(client => client.close()));
  clients.clear();
}
