import type { MongoClientOptions, ObjectId } from 'mongodb';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { instrument } from './instrument.js';
import { breakdown } from './metrics.js';

const [variant, operation, iteration = '0'] = process.argv.slice(2);
const seedOrders = [
  ['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'],
  ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a']
];
const seedOrder = variant === 'native'
  ? seedOrders[Number(iteration) % seedOrders.length]!.map(host => `mongo-${host}:27017`)
  : undefined;
const telemetry = instrument();
const { MongoClient: NativeClient } = await import('mongodb');
const { MongoClient: ServerlessClient } = await import(new URL('../../driver/dist/driver/src/index.js', import.meta.url).href) as typeof import('../driver/dist/driver/src/index.js');
const { LocalPlugin } = await import(new URL('../../plugins/local/dist/local/src/index.js', import.meta.url).href) as typeof import('../plugins/local/dist/local/src/index.js');
const topology = await readFile('/tmp/benchmark-topology.json', 'utf8');
process.env.__MONGODB_CLUSTER_TOPOLOGY = topology;
const uri = `mongodb://bench:benchmark-only@${seedOrder?.join(',') ?? 'mongo-a:27017'}/bench?replicaSet=benchmark&authSource=admin&authMechanism=SCRAM-SHA-256&tls=true`;
const options: MongoClientOptions = { tlsCAFile: '/certs/ca.crt', maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 10000, retryReads: false, retryWrites: false, writeConcern: { w: 'majority', wtimeoutMS: 10000 } };
const plugin = new LocalPlugin();
const start = performance.now();
const client = variant === 'native' ? new NativeClient(uri, options) : new ServerlessClient(uri, { ...options, plugin });
try {
  await client.connect();
  const connectReturned = performance.now();
  const collection = client.db('bench').collection<{ _id?: string | ObjectId; sample?: number; payload: string }>('documents');
  const result = operation === 'read'
    ? await collection.findOne({ _id: 'seed' }, { readPreference: 'primary' })
    : await collection.insertOne({ sample: process.pid, payload: 'benchmark' });
  const end = performance.now();
  if (operation === 'read') assert.equal(result && 'payload' in result && result.payload, 'benchmark');
  else assert.equal(result && 'acknowledged' in result && result.acknowledged, true);
  const command = telemetry.commands.find(c => c.name === (operation === 'read' ? 'find' : 'insert'));
  assert.ok(command, 'The operation must produce a measured wire command');
  assert.ok(command.socket.authorized, 'TLS must verify the certificate');
  const timings = breakdown(start, end, command.socket, command);
  console.log(JSON.stringify({ variant, operation, seedOrder, processId: process.pid, driverVersion: telemetry.version, nodeVersion: process.version, address: command.address, verified: true, connections: telemetry.connections(), timings, connectCallMs: connectReturned - start, trace: { start, end, command, sockets: telemetry.traces } }));
} finally { await client.close(); }
