import type { MongoClientOptions, ObjectId } from 'mongodb';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { instrument } from './instrument.js';
import { breakdown } from './metrics.js';

const [variant, operation] = process.argv.slice(2);
const telemetry = instrument();
const { MongoClient: NativeClient } = await import('mongodb');
const { MongoClient: ServerlessClient } = await import(new URL('../../driver/dist/driver/src/index.js', import.meta.url).href) as typeof import('../driver/dist/driver/src/index.js');
const { LocalPlugin } = await import(new URL('../../plugins/local/dist/local/src/index.js', import.meta.url).href) as typeof import('../plugins/local/dist/local/src/index.js');
const topology = await readFile('/tmp/benchmark-topology.json', 'utf8');
process.env.__MONGODB_CLUSTER_TOPOLOGY = topology;

const CONNECTION_STRING = 'mongodb+srv://bench:benchmark-only@cluster.bench.test/bench';

const READ_CONNECTION_STRING = 'mongodb://bench:benchmark-only@mongo-b.bench.test:27017/bench?authSource=admin&tls=true&directConnection=true';

const WRITE_CONNECTION_STRING = 'mongodb://bench:benchmark-only@mongo-a.bench.test:27017/bench?authSource=admin&tls=true&directConnection=true';

const uri = variant === 'native' ? CONNECTION_STRING : operation === 'read' ? READ_CONNECTION_STRING : WRITE_CONNECTION_STRING;

const readPreference = operation === 'read' ? 'secondaryPreferred' : undefined;

const options: MongoClientOptions = { authMechanism: 'SCRAM-SHA-1', tlsCAFile: '/certs/ca.crt', maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 10000, retryReads: false, retryWrites: false, writeConcern: { w: 'majority', wtimeoutMS: 10000 } };

if (readPreference) options.readPreference = readPreference;

const plugin = new LocalPlugin();
const start = performance.now();

const client = variant === 'native' ? new NativeClient(uri, options) : new ServerlessClient(uri, { ...options, plugin, disableMonitoring: variant === 'serverless-no-monitoring' });
try {
  await client.connect();
  const connectReturned = performance.now();
  const collection = client.db('bench').collection<{ _id?: string | ObjectId; value?: number; payload: string }>('documents');
  const result = operation === 'read'
    ? await collection.findOne({ _id: 'seed' }, { readPreference: 'secondaryPreferred' })
    : await collection.updateOne({ _id: 'seed' }, { $inc: { value: 1 } });
  const end = performance.now();
  if (operation === 'read') assert.equal(result && 'payload' in result && result.payload, 'benchmark');
  else assert.equal(result && 'matchedCount' in result && result.matchedCount, 1);
  const command = telemetry.commands.find(c => c.name === (operation === 'read' ? 'find' : 'update'));
  assert.ok(command, 'The operation must produce a measured wire command');
  assert.ok(command.socket.authorized, 'TLS must verify the certificate');

  if (variant === 'native' && operation === 'read') assert.ok(['SECONDARY', 'PRIMARY'].includes(command.socket.role!));
  else assert.equal(command.socket.role, operation === 'read' ? 'SECONDARY' : 'PRIMARY');
  const timings = breakdown(start, end, command.socket, command);
  console.log(JSON.stringify({ variant, operation, processId: process.pid, driverVersion: telemetry.version, nodeVersion: process.version, address: command.address, verified: true, servedRole: command.socket.role, connections: telemetry.connections(), timings, connectCallMs: connectReturned - start, trace: { start, end, command, sockets: telemetry.traces } }));
} finally { await client.close(); }
