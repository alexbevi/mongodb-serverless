import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setServers } from 'node:dns';
import { GetParameterCommand, SSMClient, type SSMClientConfig } from '@aws-sdk/client-ssm';
import { measureAwsOperation, measureProtocolOperation } from './aws-diagnostics.js';
import { initializeLazyClient } from './lambda-lifecycle.js';
import type { ServerlessClientOptions } from '../driver/src/client.js';
import { activities } from './activities.js';
import { instrument } from './instrument.js';
import { verifyPattern, variants, type PatternOperation, type PatternVariant } from './patterns.js';
import type { MongoClientOptions } from 'mongodb';

if (process.env['BENCHMARK_DNS']) setServers([process.env['BENCHMARK_DNS']]);

const telemetry = instrument(true);

const measureOperation = process.env['BENCHMARK_DIAGNOSTICS'] === 'true' ? measureAwsOperation : measureProtocolOperation;

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

let discoveryCommands = 0;

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

  const on = { commandStarted: (command: { commandName: string }) => {
    if (command.commandName === 'replSetGetStatus') discoveryCommands += 1;
  } };

  const serverlessOptions: ServerlessClientOptions = { ...options, on, disableMonitoring: true };

  if (plugin) serverlessOptions.plugin = plugin;

  const client = activities.sync("Facade / client construction", () => variant === 'native'
    ? new MongoClient(uri, options)
    : new ServerlessClient(uri, serverlessOptions));

  if (client instanceof MongoClient) client.on('commandStarted', on.commandStarted);

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
  discoveryCommands = 0;
  telemetry.traces.length = 0;
  telemetry.commands.length = 0;
  telemetry.exchanges.length = 0;
  telemetry.dns.length = 0;
  ssmCalls.length = 0;
  const cold = invocations === 1;

  const measurement = await measureOperation(async () => {
    const collection = getClient().db(process.env['DATABASE'] ?? 'bench').collection<{ _id: string; value: number }>('serverless_patterns');

    return event.operation === 'read'
      ? await collection.findOne({ _id: 'seed' }, { readPreference: 'nearest' })
      : await collection.updateOne({ _id: 'seed' }, { $inc: { value: 1 } }, { upsert: event.prepare === true });
  });

  const { result, ...timing } = measurement;
  const { start, end } = timing;
  assert.ok(result);

  if ('matchedCount' in result) assert.equal(result.matchedCount + result.upsertedCount, 1);
  else assert.equal(result._id, 'seed');

  const command = telemetry.commands.find(command => command.name === (event.operation === 'read' ? 'find' : 'update'));
  assert.ok(command?.socket.authorized, 'MongoDB TLS must verify');
  assert.ok(['PRIMARY', 'SECONDARY'].includes(command.socket.role ?? ''), 'Operations require a healthy replica-set member');

  if (event.operation === 'write') assert.equal(command.socket.role, 'PRIMARY');

  const sockets = telemetry.traces.filter(socket => socket.hello);
  const authenticated = sockets.filter(socket => socket.auth);
  const calls = [...(cold ? initialization.ssm : []), ...ssmCalls];
  const reads = calls.filter(call => call.command.startsWith('GetParameter'));

  const evidence = {
    variant, operation: event.operation, servedRole: command.socket.role ?? 'UNKNOWN',
    seedRole: authenticated[0]?.role ?? command.socket.role ?? 'UNKNOWN', sockets: sockets.length,
    authenticatedSockets: authenticated.length, monitorSockets: sockets.length - authenticated.length,
    dns: telemetry.dns.map(query => query.kind), discoveryCommands, ssmReads: reads.length,
    ssmWrites: calls.length - reads.length, cold
  };

  if (cold && !event.prepare) verifyPattern(evidence);

  assert.ok(calls.every(call => call.attempts === 1), 'SSM retries must be reported as a failed sample');

  return {
    ...evidence, verified: true, totalMs: end - start,
    ssmMs: (cold ? initialization.ssm : []).reduce((sum, call) => sum + call.end - call.start, 0), ssmPhase: 'init',
    initialization: cold ? initialization : undefined,
    environmentId, clientConstructions, nodeVersion: process.version, driverVersion: telemetry.version,
    trace: { ...timing,
      exchanges: [...telemetry.exchanges], dns: [...telemetry.dns], sockets, command, ssm: [...ssmCalls] },
    connections: telemetry.connections().map(({ uri: _uri, ...connection }) => connection)
  };
}
