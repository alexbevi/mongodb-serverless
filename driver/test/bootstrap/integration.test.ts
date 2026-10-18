import { MongoClient, type MongoClientOptions, type CommandStartedEvent } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import { startRelay } from '../../../test/harness/relay.js';
import { expect, it } from 'vitest';
import { ServerlessMongoClient } from '../../src/client.js';
import { startCluster, describeCluster } from '../../../test/harness/cluster.js';

it('discovers and routes without a plugin', async () => {
  await startCluster();
  const cluster = await describeCluster();
  const commands: CommandStartedEvent[] = [];

  const client = new ServerlessMongoClient(cluster.uri, {
    monitorCommands: true,
    on: { commandStarted: event => commands.push(event) }
  });

  try {
    const collection = client.db('bootstrap').collection('withoutPlugin');
    await collection.insertOne({ value: 1 });
    await collection.findOne({ value: 1 });

    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
    expect(commands.find(event => event.commandName === 'insert')?.address.split(':').at(-1)).toBe(cluster.primary.split(':').at(-1));
    expect(cluster.secondaries.map(host => host.split(':').at(-1))).toContain(
      commands.find(event => event.commandName === 'find')?.address.split(':').at(-1)
    );
  } finally {
    await client.close().catch(() => {});
  }
}, 120_000);

async function observeCluster() {
  await startCluster();
  const cluster = await describeCluster();
  const relays = new Map<string, Awaited<ReturnType<typeof startRelay>>>();
  const clients: MongoClient[] = [];
  const commands: CommandStartedEvent[] = [];

  for (const host of [cluster.primary, ...cluster.secondaries]) {
    relays.set(host, await startRelay(Number(host.split(':').at(-1))));
  }

  return {
    cluster, relays, clients, commands,
    createClient(uri: string, options?: MongoClientOptions): MongoClient {
      const target = new ConnectionString(uri);
      target.hosts = target.hosts.map(host => {
        const relay = relays.get(host);

        if (!relay) throw new Error(`Unexpected member ${host}`);

        return `127.0.0.1:${relay.port}`;
      });
      const client = new MongoClient(target.toString(), options);
      client.on('commandStarted', event => commands.push(event));
      clients.push(client);

      return client;
    },
    async close() {
      await Promise.all([...relays.values()].map(relay => relay.close()));
    }
  };
}

it('reuses the bootstrap socket when the first write lands on the primary', async () => {
  const observed = await observeCluster();
  const { cluster, relays, clients, commands, createClient } = observed;

  const client = new ServerlessMongoClient(`mongodb://${cluster.primary}/bootstrap?directConnection=true`, {
    disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient
  });

  try {
    await client.db().collection('luckyPrimary').insertOne({ value: 1 });
    expect(clients).toHaveLength(1);
    expect(relays.get(cluster.primary)?.counts.accepted).toBe(1);
    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
    const discovery = commands.find(event => event.commandName === 'replSetGetStatus');
    const insert = commands.find(event => event.commandName === 'insert');
    expect(insert?.connectionId).toBe(discovery?.connectionId);
    expect(insert?.address).toBe(discovery?.address);
  } finally {
    await client.close();
    await observed.close();
  }

  for (const relay of relays.values()) expect(relay.counts.open).toBe(0);
}, 120_000);
