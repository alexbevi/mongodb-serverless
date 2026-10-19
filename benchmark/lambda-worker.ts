import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setServers } from 'node:dns';
import { GetParameterCommand, SSMClient, type SSMClientConfig } from '@aws-sdk/client-ssm';
import { measureAwsOperation } from './aws-diagnostics.js';
import { activities } from './activities.js';
import { instrument } from './instrument.js';
import { verifyPattern, variants, type PatternOperation, type PatternVariant } from './patterns.js';
import type { MongoClientOptions } from 'mongodb';

if (process.env['BENCHMARK_DNS']) setServers([process.env['BENCHMARK_DNS']]);

const telemetry = instrument(true);

const { MongoClient } = await import('mongodb');

// SAFETY: The deployment builder copies these compiled packages beside benchmark/dist.
const { MongoClient: ServerlessClient } = await import(new URL('../../driver/dist/driver/src/index.js', import.meta.url).href) as typeof import('../driver/dist/driver/src/index.js');

// SAFETY: This is the SSM package built by the same TypeScript project.
const { SsmPlugin } = await import(new URL('../../plugins/ssm/dist/ssm/src/index.js', import.meta.url).href) as typeof import('../plugins/ssm/dist/ssm/src/index.js');

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

const environmentId = randomUUID();

let invocations = 0;

export async function handler(event: { variant: PatternVariant; operation: PatternOperation; prepare?: boolean }) {
  let client: InstanceType<typeof MongoClient> | InstanceType<typeof ServerlessClient> | undefined;
  let discoveryCommands = 0;

  try {
    const measurement = await measureAwsOperation(async () => {
      invocations += 1;
      assert.equal(invocations, 1, 'A warm invocation cannot enter the cold cohort');
      assert.ok(variants.includes(event.variant));
      assert.ok(['read', 'write'].includes(event.operation));
      const uriParameter = process.env['URI_PARAMETER'];
      const topologyParameter = process.env['TOPOLOGY_PARAMETER'];
      assert.ok(uriParameter && topologyParameter);

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

      const plugin = new SsmPlugin({ client: ssm, connectionStringParameter: uriParameter, topologyParameter });

      if (event.variant === 'ssm') {
        client = activities.sync("Facade / client construction", () => new ServerlessClient(undefined, { ...options, plugin, on, disableMonitoring: true }));
      } else {
        const parameter = await ssm.send(new GetParameterCommand({ Name: uriParameter, WithDecryption: true }));
        assert.equal(parameter.Parameter?.Type, 'SecureString');
        const uri = parameter.Parameter?.Value;
        assert.ok(uri);
        client = activities.sync("Facade / client construction", () => event.variant === 'native' ? new MongoClient(uri, options)
          : new ServerlessClient(uri, { ...options, on, disableMonitoring: true }));

        if (client instanceof MongoClient) client.on('commandStarted', on.commandStarted);
      }

      const collection = client.db(process.env['DATABASE'] ?? 'bench').collection<{ _id: string; value: number }>('serverless_patterns');

      return event.operation === 'read'
        ? await collection.findOne({ _id: 'seed' }, { readPreference: 'nearest' })
        : await collection.updateOne({ _id: 'seed' }, { $inc: { value: 1 } }, { upsert: event.prepare === true });
    });

    const { start, end, result } = measurement;
    assert.ok(result);

    if ('matchedCount' in result) assert.equal(result.matchedCount + result.upsertedCount, 1);
    else assert.equal(result._id, 'seed');
    const command = telemetry.commands.find(command => command.name === (event.operation === 'read' ? 'find' : 'update'));
    assert.ok(command?.socket.authorized, 'MongoDB TLS must verify');
    const sockets = telemetry.traces.filter(socket => socket.hello);
    const authenticated = sockets.filter(socket => socket.auth);
    const reads = ssmCalls.filter(call => call.command.startsWith('GetParameter'));

    const evidence = {
      variant: event.variant, operation: event.operation, servedRole: command.socket.role ?? 'UNKNOWN',
      seedRole: authenticated[0]?.role ?? 'UNKNOWN', sockets: sockets.length,
      authenticatedSockets: authenticated.length, monitorSockets: sockets.length - authenticated.length,
      dns: telemetry.dns.map(query => query.kind), discoveryCommands, ssmReads: reads.length,
      ssmWrites: ssmCalls.length - reads.length, cold: invocations === 1
    };

    if (!event.prepare) verifyPattern(evidence);
    assert.ok(ssmCalls.every(call => call.attempts === 1), 'SSM retries must be reported as a failed sample');

    return {
      ...evidence, verified: true, totalMs: end - start,
      ssmMs: ssmCalls.reduce((sum, call) => sum + call.end - call.start, 0),
      environmentId, nodeVersion: process.version, driverVersion: telemetry.version,
      trace: { start, end, execution: measurement.execution, activities: measurement.activities, exchanges: telemetry.exchanges, dns: telemetry.dns, sockets, command, ssm: ssmCalls },
      connections: telemetry.connections().map(({ uri: _uri, ...connection }) => connection)
    };
  } finally {
    await client?.close();
  }
}
