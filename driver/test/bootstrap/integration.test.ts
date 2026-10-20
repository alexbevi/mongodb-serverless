import { MongoClient, type MongoClientOptions, type CommandStartedEvent } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import { startRelay, tcpPort } from '../../../test/harness/relay.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { ServerlessMongoClient } from '../../src/client.js';
import { openDiscovery } from '../../src/discovery.js';
import { startCluster, describeCluster } from '../../../test/harness/cluster.js';

afterEach(() => vi.restoreAllMocks());

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

it('uses the secondary it landed on even when another secondary appears first', async () => {
  const observed = await observeCluster();
  const { cluster, relays, clients, commands, createClient } = observed;
  const landed = cluster.secondaries[1]!;

  const client = new ServerlessMongoClient(`mongodb://${landed}/bootstrap`, {
    disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient
  });

  try {
    const collection = client.db().collection('luckySecondary');
    await collection.findOne({ value: 1 });
    expect(clients).toHaveLength(1);
    expect(relays.get(landed)?.counts.accepted).toBe(1);
    expect(relays.get(cluster.secondaries[0]!)?.counts.accepted).toBe(0);
    const discovery = commands.find(event => event.commandName === 'replSetGetStatus');
    const read = commands.find(event => event.commandName === 'find');
    expect(read?.connectionId).toBe(discovery?.connectionId);
    expect(read?.address).toBe(discovery?.address);

    await collection.insertOne({ value: 1 });
    await collection.findOne({ value: 1 });
    expect(clients).toHaveLength(2);
    expect([...relays.values()].reduce((sum, relay) => sum + relay.counts.accepted, 0)).toBe(2);
    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
  } finally {
    await client.close();
    await observed.close();
  }
}, 120_000);

it.each(['read', 'write'] as const)('adds one connection when the first %s needs another member', async operation => {
  const observed = await observeCluster();
  const { cluster, relays, clients, commands, createClient } = observed;
  const landed = operation === 'read' ? cluster.primary : cluster.secondaries[1]!;

  const client = new ServerlessMongoClient(`mongodb://${landed}/bootstrap`, {
    disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient
  });

  try {
    const collection = client.db().collection('otherMember');

    if (operation === 'read') await collection.findOne({});
    else await collection.insertOne({ value: 1 });

    expect(clients).toHaveLength(2);
    expect([...relays.values()].reduce((sum, relay) => sum + relay.counts.accepted, 0)).toBe(2);
    const discovery = commands.find(event => event.commandName === 'replSetGetStatus');
    const served = commands.find(event => event.commandName === (operation === 'read' ? 'find' : 'insert'));
    expect(discovery?.address).not.toBe(served?.address);
    const destination = operation === 'read' ? cluster.secondaries[0]! : cluster.primary;
    expect(served?.address).toBe(`127.0.0.1:${relays.get(destination)!.port}`);

    await collection.findOne({});
    await collection.insertOne({ value: 2 });
    expect(clients).toHaveLength(2);
    expect([...relays.values()].reduce((sum, relay) => sum + relay.counts.accepted, 0)).toBe(2);
    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
  } finally {
    await client.close();
    await observed.close();
  }
}, 120_000);

it('shares one bootstrap and socket across concurrent first writes', async () => {
  const observed = await observeCluster();
  const { cluster, relays, clients, commands, createClient } = observed;

  const client = new ServerlessMongoClient(`mongodb://${cluster.primary}/bootstrap`, {
    disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient
  });

  try {
    await Promise.all(Array.from({ length: 10 }, (_, value) =>
      client.db().collection('concurrent').insertOne({ value })
    ));
    expect(clients).toHaveLength(1);
    expect(relays.get(cluster.primary)?.counts.accepted).toBe(1);
    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
    expect(commands.filter(event => event.commandName === 'insert')).toHaveLength(10);
  } finally {
    await client.close();
    await observed.close();
  }
}, 120_000);

it('chooses different initial members from the seed list without contacting every member', async () => {
  const observed = await observeCluster();
  const { cluster, relays, clients, createClient } = observed;
  const secondary = cluster.secondaries[1]!;

  try {
    for (const random of [0.99, 0]) {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const uri = `mongodb://${cluster.primary},${secondary}/bootstrap`;

      const client = new ServerlessMongoClient(uri, {
        disableMonitoring: true, maxPoolSize: 1, createClient
      });

      try {
        await client.db().collection('randomSeed').findOne({});
        const initial = clients.at(random === 0.99 ? 0 : 2)!;
        const chosen = random === 0.99 ? cluster.primary : secondary;
        expect(initial.options.hosts.map(String)).toEqual([`127.0.0.1:${relays.get(chosen)!.port}`]);
      } finally {
        await client.close();
      }
    }

    expect(clients).toHaveLength(3);
    expect([...relays.values()].reduce((sum, relay) => sum + relay.counts.accepted, 0)).toBe(3);
  } finally {
    await observed.close();
  }
}, 120_000);

it('tries another seed after a failed handshake and closes the failed client', async () => {
  const observed = await observeCluster();
  const { cluster, relays, clients, commands, createClient } = observed;
  const unavailable = createServer(socket => socket.destroy());
  unavailable.listen(0, '127.0.0.1');
  await once(unavailable, 'listening');
  const failed = `localhost:${tcpPort(unavailable)}`;
  relays.set(failed, await startRelay(tcpPort(unavailable)));
  vi.spyOn(Math, 'random').mockReturnValue(0.99);

  const client = new ServerlessMongoClient(`mongodb://${failed},${cluster.primary}/bootstrap`, {
    disableMonitoring: true, maxPoolSize: 1, serverSelectionTimeoutMS: 200, monitorCommands: true, createClient
  });

  try {
    await client.db().collection('failedSeed').insertOne({ value: 1 });
    expect(clients).toHaveLength(2);
    expect(relays.get(cluster.primary)?.counts.accepted).toBe(1);
    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
    await vi.waitFor(() => expect(relays.get(failed)?.counts.open).toBe(0));
  } finally {
    await client.close();
    await observed.close();
    await new Promise<void>(resolve => unavailable.close(() => resolve()));
  }
}, 120_000);

it('closes the bootstrap connection if persisting topology fails', async () => {
  const observed = await observeCluster();
  const { cluster, relays, commands, createClient } = observed;
  const failure = new Error('topology store unavailable');

  const client = new ServerlessMongoClient(`mongodb://${cluster.primary}/bootstrap`, {
    disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient,
    plugin: {
      name: 'unavailable', version: '1', author: 'test',
      async setup() {}, async verify() {}, async read() { return null; },
      async write() { throw failure; }
    }
  });

  try {
    await expect(client.db().collection('persistenceFailure').insertOne({})).rejects.toBe(failure);
    expect(commands.filter(event => event.commandName === 'insert')).toHaveLength(0);
    await vi.waitFor(() => expect(relays.get(cluster.primary)?.counts.open).toBe(0));
  } finally {
    await client.close();
    await observed.close();
  }
}, 120_000);

it('discovers once per client when no shared topology store is configured', async () => {
  const observed = await observeCluster();
  const { cluster, clients, commands, createClient } = observed;

  try {
    for (let run = 0; run < 2; run++) {
      const client = new ServerlessMongoClient(`mongodb://${cluster.primary}/bootstrap`, {
        disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient
      });

      try {
        await client.db().collection('clientLifetime').insertOne({ run });
        await client.db().collection('clientLifetime').insertOne({ run });
      } finally {
        await client.close();
      }
    }

    expect(clients).toHaveLength(2);
    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(2);
    expect(commands.filter(event => event.commandName === 'insert')).toHaveLength(4);
  } finally {
    await observed.close();
  }
}, 120_000);

it('closes a discovered socket when close races with topology persistence', async () => {
  const observed = await observeCluster();
  const { cluster, relays, commands, createClient } = observed;
  let release!: () => void;
  let started!: () => void;
  const persisting = new Promise<void>(resolve => { started = resolve; });
  const stored = new Promise<void>(resolve => { release = resolve; });

  const client = new ServerlessMongoClient(`mongodb://${cluster.primary}/bootstrap`, {
    disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient,
    plugin: {
      name: 'delayed', version: '1', author: 'test',
      async setup() {}, async verify() {}, async read() { return null; },
      async write() { started(); await stored; }
    }
  });

  try {
    const operation = client.db().collection('closing').insertOne({}).catch(error => error);
    await persisting;
    const closing = client.close();
    release();
    await closing;
    expect(await operation).toMatchObject({ message: expect.stringMatching(/closed/) });
    expect(commands.filter(event => event.commandName === 'insert')).toHaveLength(0);
    await vi.waitFor(() => expect(relays.get(cluster.primary)?.counts.open).toBe(0));
  } finally {
    release();
    await client.close();
    await observed.close();
  }
}, 120_000);

it('reuses either discovered role for an unrestricted nearest read', async () => {
  const observed = await observeCluster();
  const { cluster, clients, commands, createClient } = observed;

  try {
    for (const host of [cluster.primary, ...cluster.secondaries]) {
      const before = clients.length;

      const client = new ServerlessMongoClient(`mongodb://${host}/bootstrap`, {
        disableMonitoring: true, maxPoolSize: 1, monitorCommands: true, createClient
      });

      try {
        await client.db().collection('anyMember').findOne({}, { readPreference: 'nearest' });
        const discovery = commands.findLast(event => event.commandName === 'replSetGetStatus');
        const read = commands.findLast(event => event.commandName === 'find');
        expect(clients.length - before).toBe(1);
        expect(read?.address).toBe(discovery?.address);
        expect(read?.connectionId).toBe(discovery?.connectionId);
      } finally {
        await client.close();
      }
    }
  } finally {
    await observed.close();
  }
}, 120_000);


it('uses handshake identity for discovery without another hello', async () => {
  const observed = await observeCluster();
  const { cluster, commands, createClient } = observed;

  try {
    for (const disableMonitoring of [false, true]) {
      const discovered = await openDiscovery(
        `mongodb://${cluster.primary}/bootstrap?replicaSet=${cluster.status.set}`,
        createClient, { monitorCommands: true, maxPoolSize: 1 }, undefined, disableMonitoring
      );

      try {
        expect(discovered.host).toBe(cluster.primary);
        expect(discovered.type).toBe('RSPrimary');
        expect(discovered.status.set).toBe(cluster.status.set);
      } finally {
        await discovered.client.close();
      }
    }

    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(2);
    expect(commands.filter(event => event.commandName === 'hello')).toHaveLength(0);
  } finally {
    await observed.close();
  }
}, 120_000);
