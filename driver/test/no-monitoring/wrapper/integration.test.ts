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
