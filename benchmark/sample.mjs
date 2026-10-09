import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { instrument } from './instrument.mjs';
import { breakdown } from './metrics.mjs';

const [variant, operation] = process.argv.slice(2);
const telemetry = instrument();
const { MongoClient: NativeClient } = await import('mongodb');
const { MongoClient: ServerlessClient } = await import('../driver/dist/driver/src/index.js');
const { LocalPlugin } = await import('../plugins/local/dist/local/src/index.js');
const topology = await readFile('/tmp/benchmark-topology.json', 'utf8');
process.env.__MONGODB_CLUSTER_TOPOLOGY = topology;
const uri = 'mongodb://bench:benchmark-only@mongo-a:27017,mongo-b:27017,mongo-c:27017/bench?replicaSet=benchmark&authSource=admin&authMechanism=SCRAM-SHA-256&tls=true';
const options = { tlsCAFile: '/certs/ca.crt', maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 10000, retryReads: false, retryWrites: false, writeConcern: { w: 'majority', wtimeoutMS: 10000 } };
const plugin = new LocalPlugin();
const start = performance.now();
const client = variant === 'native' ? new NativeClient(uri, options) : new ServerlessClient(uri, { ...options, plugin });
let result;
try {
  await client.connect();
  const connectReturned = performance.now();
  const collection = client.db('bench').collection('documents');
  result = operation === 'read'
    ? await collection.findOne({ _id: 'seed' }, { readPreference: 'primary' })
    : await collection.insertOne({ sample: process.pid, payload: 'benchmark' });
  const end = performance.now();
  if (operation === 'read') assert.equal(result?.payload, 'benchmark');
  else assert.equal(result.acknowledged, true);
  const command = telemetry.commands.find(c => c.name === (operation === 'read' ? 'find' : 'insert'));
  assert.ok(command, 'The operation must produce a measured wire command');
  assert.ok(command.socket.authorized, 'TLS must verify the certificate');
  const timings = breakdown(start, end, command.socket, command);
  console.log(JSON.stringify({ variant, operation, processId: process.pid, driverVersion: telemetry.version, nodeVersion: process.version, address: command.address, verified: true, timings, connectCallMs: connectReturned - start, trace: { start, end, command, sockets: telemetry.traces } }));
} finally { await client.close(); }
