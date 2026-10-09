import { MongoClient } from 'mongodb';
import { writeFile } from 'node:fs/promises';
const client = new MongoClient('mongodb://bench:benchmark-only@mongo-a:27017/bench?directConnection=true&authSource=admin&tls=true', { tlsCAFile: '/certs/ca.crt' });
try {
  await client.connect();
  const status = await client.db('admin').command({ replSetGetStatus: 1 });
  if (status.members.filter(m => m.stateStr === 'SECONDARY').length !== 2) throw new Error('Two secondaries required');
  if (status.members.find(m => m.stateStr === 'PRIMARY').name !== 'mongo-a:27017') throw new Error('mongo-a must be primary');
  await client.db('bench').collection('documents').replaceOne({ _id: 'seed' }, { _id: 'seed', payload: 'benchmark' }, { upsert: true, writeConcern: { w: 3, wtimeoutMS: 10000 } });
  await writeFile('/tmp/benchmark-topology.json', JSON.stringify(status));
} finally { await client.close(); }
