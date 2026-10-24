import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setServers } from 'node:dns';
import { GetParameterCommand, SSMClient, type SSMClientConfig } from '@aws-sdk/client-ssm';
import { createRequire } from 'node:module';
import { recordEvents } from './events.js';
import { initializeLazyClient } from './lambda-lifecycle.js';
import type { ServerlessClientOptions } from '../driver/src/client.js';
import { verifyPattern, variants, type PatternOperation, type PatternVariant } from './patterns.js';
import type { MongoClientOptions } from 'mongodb';

if (process.env['BENCHMARK_DNS']) setServers([process.env['BENCHMARK_DNS']]);

const events = recordEvents();

// SAFETY: Every npm package manifest has a string version field.
const { version: driverVersion } = createRequire(import.meta.url)('mongodb/package.json') as { version: string };

const { MongoClient } = await import('mongodb');

// SAFETY: The deployment builder copies these compiled packages beside benchmark/dist.
const { MongoClient: ServerlessClient } = await import(new URL('../../driver/dist/driver/src/index.js', import.meta.url).href) as typeof import('../driver/dist/driver/src/index.js');

// SAFETY: This is the SSM package built by the same TypeScript project.
const { SsmPlugin } = await import(new URL('../../plugins/aws-ssm/dist/aws-ssm/src/index.js', import.meta.url).href) as typeof import('../plugins/aws-ssm/dist/aws-ssm/src/index.js');

const ssmOptions: SSMClientConfig = { maxAttempts: 1 };

if (process.env['SSM_ENDPOINT']) ssmOptions.endpoint = process.env['SSM_ENDPOINT'];

const ssm = new SSMClient(ssmOptions);

const ssmCalls: { command: string; start: number; end: number; attempts: number }[] = [];

ssm.middlewareStack.add((next, context) => async args => {
  const start = performance.now();
  const result = await next(args);
  ssmCalls.push({ command: context.commandName ?? 'unknown', start, end: performance.now(), attempts: result.output.$metadata.attempts ?? 1 });

  return result;
}, { step: 'initialize', name: 'benchmarkSsmTiming' });

function deployedVariant() {
  const variant = variants.find(value => value === process.env['BENCHMARK_VARIANT']);
  assert.ok(variant, 'BENCHMARK_VARIANT must identify this function');

  return variant;
}

const variant = deployedVariant();

const uriParameter = process.env['URI_PARAMETER'];

const topologyParameter = process.env['TOPOLOGY_PARAMETER'];

assert.ok(uriParameter && topologyParameter);

const plugin = variant === 'ssm' || variant === 'ssm-uncached'
  ? new SsmPlugin({ client: ssm, connectionStringParameter: uriParameter, topologyParameter })
  : undefined;

async function fetchConnectionString() {
  if (plugin) return await plugin.getConnectionString();

  const parameter = await ssm.send(new GetParameterCommand({ Name: uriParameter, WithDecryption: true }));
  assert.equal(parameter.Parameter?.Type, 'SecureString');
  assert.ok(parameter.Parameter?.Value);

  return parameter.Parameter.Value;
}

const environmentId = randomUUID();

let invocations = 0;

let clientConstructions = 0;

const getClient = await initializeLazyClient(fetchConnectionString, uri => {
  clientConstructions += 1;

  const options: MongoClientOptions = {
    monitorCommands: true, maxPoolSize: 1, minPoolSize: 0, authMechanism: 'SCRAM-SHA-1',
    serverSelectionTimeoutMS: 8000, connectTimeoutMS: 5000, socketTimeoutMS: 10000,
    retryReads: false, retryWrites: false, readPreference: 'nearest',
    writeConcern: { w: 'majority', wtimeoutMS: 10000 }
  };

  if (process.env['MONGODB_CA']) options.tlsCAFile = process.env['MONGODB_CA'];

  if (variant !== 'native') {
    // SAFETY: Each recorder listener accepts the driver's event objects; `on` attaches them to every native client.
    const serverlessOptions: ServerlessClientOptions = { ...options, on: events.listeners as NonNullable<ServerlessClientOptions['on']>, disableMonitoring: true };

    if (plugin) serverlessOptions.plugin = plugin;

    return new ServerlessClient(uri, serverlessOptions);
  }

  const client = new MongoClient(uri, options);

  for (const [name, listener] of Object.entries(events.listeners)) client.on(name, listener);

  return client;
});

const initialization = { ssm: ssmCalls.splice(0), processReadyMs: performance.now() };

export async function handler(
  event: { variant: PatternVariant; operation: PatternOperation; prepare?: boolean },
  context?: { callbackWaitsForEmptyEventLoop: boolean }
) {
  if (context) context.callbackWaitsForEmptyEventLoop = false;

  assert.equal(event.variant, variant, 'The event must match the deployed function variant');
  assert.ok(['read', 'write'].includes(event.operation));
  invocations += 1;
  ssmCalls.length = 0;
  const cold = invocations === 1;
  const start = performance.now();
  events.reset(start);
  const collection = getClient().db(process.env['DATABASE'] ?? 'bench').collection<{ _id: string; value: number }>('serverless_patterns');

  const result = event.operation === 'read'
    ? await collection.findOne({ _id: 'seed' }, { readPreference: 'nearest' })
    : await collection.updateOne({ _id: 'seed' }, { $inc: { value: 1 } }, { upsert: event.prepare === true });

  const end = performance.now();
  const trace = events.trace(end);
  assert.ok(result);

  if ('matchedCount' in result) assert.equal(result.matchedCount + result.upsertedCount, 1);
  else assert.equal(result._id, 'seed');

  const { command } = trace;
  assert.ok(command?.socket?.authorized, 'MongoDB TLS must verify');
  assert.ok(['PRIMARY', 'SECONDARY'].includes(command.socket.role), 'Operations require a healthy replica-set member');

  if (event.operation === 'write') assert.equal(command.socket.role, 'PRIMARY');

  const authenticated = trace.sockets.filter(socket => socket.kind === 'application');
  const calls = [...(cold ? initialization.ssm : []), ...ssmCalls];
  const reads = calls.filter(call => call.command.startsWith('GetParameter'));

  const evidence = {
    variant, operation: event.operation, servedRole: command.socket.role,
    seedRole: authenticated[0]?.role ?? command.socket.role, sockets: trace.sockets.length,
    authenticatedSockets: authenticated.length, monitorSockets: trace.sockets.length - authenticated.length,
    discoveryCommands: trace.commands.filter(command => command.name === 'replSetGetStatus').length,
    ssmReads: reads.length, ssmWrites: calls.length - reads.length, cold
  };

  if (cold && !event.prepare) verifyPattern(evidence);

  assert.ok(calls.every(call => call.attempts === 1), 'SSM retries must be reported as a failed sample');

  return {
    ...evidence, verified: true, totalMs: end - start,
    ssmMs: (cold ? initialization.ssm : []).reduce((sum, call) => sum + call.end - call.start, 0), ssmPhase: 'init',
    initialization: cold ? initialization : undefined,
    environmentId, clientConstructions, nodeVersion: process.version, driverVersion,
    trace: { ...trace, ssm: [...ssmCalls] }
  };
}
