import { MongoClient } from 'mongodb';
import { expect, it } from 'vitest';
import { ServerlessMongoClient } from '../../../src/client.js';
import { TestPlugin } from '../../harness/plugin.js';
import { startCluster, describeCluster } from '../../../../test/harness/cluster.js';
import { startRelay } from '../../../../test/harness/relay.js';

it('opts the wrapper into one lazy connection when reads and writes share a host', async () => {
  await startCluster();
  const cluster = await describeCluster();
  const relay = await startRelay(Number(cluster.primary.split(':')[1]));

  const status = { ...cluster.status, members: cluster.status.members.flatMap(member =>
    member.stateStr === 'PRIMARY' ? [{ ...member, name: `127.0.0.1:${relay.port}` }] : []) };

  const plugin = new TestPlugin(status);
  let factories = 0;

  const client = new ServerlessMongoClient(cluster.uri, {
    plugin, disableMonitoring: true, maxPoolSize: 1,
    createClient: (uri, options) => { factories++;

 return new MongoClient(uri, options); }
  });

  try {
    await client.connect();
    expect(relay.counts.accepted).toBe(0);
    const collection = client.db('test').collection('wrapperNoMonitoring');
    const result = await collection.insertOne({ value: 1 });
    expect(await collection.findOne({ _id: result.insertedId })).toMatchObject({ value: 1 });
    expect(relay.counts.accepted).toBe(1);
    expect(factories).toBe(1);
    expect(plugin.reads).toBe(1);
  } finally {
    await client.close();
    await relay.close();
  }
}, 120_000);

it('uses separate sockets for a first cursor read and first bulk write', async () => {
  await startCluster();
  const cluster = await describeCluster();
  const primary = await startRelay(Number(cluster.primary.split(':')[1]));
  const secondaryHost = cluster.secondaries[0];

  if (!secondaryHost) throw new Error('Missing secondary');
  const secondary = await startRelay(Number(secondaryHost.split(':')[1]));

  const status = { ...cluster.status, members: cluster.status.members.flatMap(member => {
    if (member.name === cluster.primary) return [{ ...member, name: `127.0.0.1:${primary.port}` }];

    if (member.name === secondaryHost) return [{ ...member, name: `127.0.0.1:${secondary.port}` }];

    return [];
  }) };

  const client = new ServerlessMongoClient(cluster.uri, {
    plugin: new TestPlugin(status), disableMonitoring: true, maxPoolSize: 1
  });

  try {
    const collection = client.db('test').collection('firstOperations');
    await collection.find({}).limit(1).toArray();
    expect(secondary.counts.accepted).toBe(1);
    expect(primary.counts.accepted).toBe(0);
    const bulk = collection.initializeOrderedBulkOp();
    bulk.insert({ value: 1 });
    expect((await bulk.execute()).insertedCount).toBe(1);
    expect(primary.counts.accepted).toBe(1);
    expect(secondary.counts.accepted).toBe(1);
  } finally {
    await client.close();
    await Promise.all([primary.close(), secondary.close()]);
  }
});
