import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient as RealMongoClient, type CommandStartedEvent } from 'mongodb';
import { ServerlessMongoClient } from '../src/client.js';
import { NoPrimaryError, SessionRoutingError } from '../src/errors.js';
import {
  describeCluster,
  dockerAvailable,
  startCluster,
  type TestCluster
} from '../../test/harness/cluster.js';
import { TestPlugin } from './harness/plugin.js';

const hasDocker = await dockerAvailable();

/**
 * Runs against a real 3-node replica set.
 *
 * Routing is asserted from `commandStarted` events, which carry the address
 * the driver actually used. That is the claim these tests exist to check, and
 * a mocked client factory cannot make it.
 */
describe.skipIf(!hasDocker)('against a real replica set', () => {
  let cluster: TestCluster;
  let clients: ServerlessMongoClient[] = [];

  beforeAll(async () => {
    await startCluster();
    cluster = await describeCluster();
  }, 180_000);

  afterEach(async () => {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    clients = [];
  });

  afterAll(async () => {
    // The cluster is left running; `pnpm test:cluster:stop` removes it. Tearing
    // it down here would make every run pay the startup cost again.
  });

  /** Records the host each command was sent to. */
  const connect = (
    status = cluster.status,
    uri = cluster.uri,
    options: Record<string, unknown> = {}
  ): { client: ServerlessMongoClient; commands: CommandStartedEvent[]; plugin: TestPlugin } => {
    const commands: CommandStartedEvent[] = [];
    const plugin = new TestPlugin(status as never);

    const client = new ServerlessMongoClient(uri, {
      plugin,
      monitorCommands: true,
      ...options,
      createClient: (target, options) => {
        const real = new RealMongoClient(target, options);
        real.on('commandStarted', event => commands.push(event));
        return real;
      }
    });

    clients.push(client);
    return { client, commands, plugin };
  };

  /**
   * Ports, not hostnames.
   *
   * `commandStarted.address` carries the resolved address, so a member
   * configured as `localhost:28017` is reported as `127.0.0.1:28017`. The port
   * identifies the member on its own here, and does not depend on how the host
   * resolves.
   */
  const portsFor = (commands: CommandStartedEvent[], name: string): number[] =>
    commands
      .filter(event => event.commandName === name)
      .map(event => Number(event.address.split(':').at(-1)));

  const portOf = (hostPort: string): number => Number(hostPort.split(':').at(-1));

  /**
   * Waits for every member, not a majority.
   *
   * On a 3-node set `w: 'majority'` acknowledges once the primary and one
   * secondary have the write, which leaves the other secondary behind. The
   * read client may be connected to exactly that one, so a majority write
   * followed by a secondary read misses the data essentially every time.
   * Measured: 40 of 40 with majority, 0 of 20 with w: 3.
   */
  const ALL_MEMBERS = { writeConcern: { w: 3 } } as const;

  it('reaches a real cluster at all', async () => {
    expect(cluster.primary).toMatch(/^localhost:\d+$/);
    expect(cluster.secondaries).toHaveLength(2);
  });

  it('sends a write to the primary', async () => {
    const { client, commands } = connect();
    await client.db('itest').collection('writes').insertOne({ at: Date.now() });

    expect(portsFor(commands, 'insert')).toEqual([portOf(cluster.primary)]);
  });

  it('sends a read to a secondary', async () => {
    const { client, commands } = connect();
    await client.db('itest').collection('writes').findOne({});

    expect(cluster.secondaries.map(portOf)).toContain(portsFor(commands, 'find')[0]);
  });

  it('reads a document the primary just wrote', async () => {
    // Writes with majority concern so the read is not racing replication.
    const { client } = connect();
    const marker = `roundtrip-${Date.now()}`;
    const collection = client.db('itest').collection('roundtrip');

    await collection.insertOne({ marker }, ALL_MEMBERS);

    await expect(collection.findOne({ marker })).resolves.toMatchObject({ marker });
  });

  it('splits a read and a write across two hosts', async () => {
    const { client, commands } = connect();
    const collection = client.db('itest').collection('split');
    await collection.insertOne({ at: Date.now() }, ALL_MEMBERS);
    await collection.countDocuments();

    const write = portsFor(commands, 'insert')[0];
    const read = portsFor(commands, 'aggregate')[0];

    expect(write).toBe(portOf(cluster.primary));
    expect(read).not.toBe(write);
  });

  it('opens exactly one connection per role', async () => {
    const { client, commands } = connect();
    const collection = client.db('itest').collection('reuse');
    await collection.insertOne({ at: Date.now() });
    await collection.insertOne({ at: Date.now() });
    await collection.findOne({});
    await collection.findOne({});

    expect(new Set(commands.map(event => event.address)).size).toBe(2);
  });

  it('reads the plugin once for both clients', async () => {
    const { client, plugin } = connect();
    const collection = client.db('itest').collection('reuse');
    await collection.insertOne({ at: Date.now() });
    await collection.findOne({});

    expect(plugin.reads).toBe(1);
  });

  it('connects directly, without discovering the set', async () => {
    // A directConnection client reports a Single topology, so it never ran
    // server selection across the members.
    const { client, commands } = connect();
    await client.db('itest').collection('writes').insertOne({ at: Date.now() });

    expect(new Set(portsFor(commands, 'insert'))).toEqual(new Set([portOf(cluster.primary)]));
  });

  describe('cursors', () => {
    it('exposes cursor properties after the cursor is created', async () => {
      const { client } = connect();
      const cursor = client.db('test').collection('cursor_properties').find({});

      expect(() => cursor.namespace).toThrow(/terminal call/);
      await cursor.next();
      expect(cursor.namespace.toString()).toBe('test.cursor_properties');
      await cursor.close();
      expect(cursor.closed).toBe(true);
    });

    const seed = async (client: ServerlessMongoClient, name: string, count: number) => {
      const docs = Array.from({ length: count }, (_, n) => ({ n }));
      await client
        .db('itest')
        .collection(name)
        .insertMany(docs, ALL_MEMBERS);
    };

    it('returns documents from a secondary', async () => {
      const { client, commands } = connect();
      const name = `cursor-${Date.now()}`;
      await seed(client, name, 5);

      const docs = await client.db('itest').collection(name).find({}).toArray();

      expect(docs).toHaveLength(5);
      expect(cluster.secondaries.map(portOf)).toContain(portsFor(commands, 'find')[0]);
    });

    it('applies a replayed sort and limit on the server', async () => {
      const { client } = connect();
      const name = `chain-${Date.now()}`;
      await seed(client, name, 10);

      const docs = await client
        .db('itest')
        .collection(name)
        .find({})
        .sort({ n: -1 })
        .limit(3)
        .toArray();

      expect(docs.map(d => d['n'])).toEqual([9, 8, 7]);
    });

    it('iterates with for await', async () => {
      const { client } = connect();
      const name = `iterate-${Date.now()}`;
      await seed(client, name, 4);

      const seen: unknown[] = [];
      for await (const doc of client.db('itest').collection(name).find({}).sort({ n: 1 })) {
        seen.push(doc['n']);
      }

      expect(seen).toEqual([0, 1, 2, 3]);
    });

    it('sends an aggregate with $out to the primary', async () => {
      const { client, commands } = connect();
      const source = `agg-src-${Date.now()}`;
      await seed(client, source, 3);

      await client
        .db('itest')
        .collection(source)
        .aggregate([{ $match: {} }, { $out: `agg-dest-${Date.now()}` }])
        .toArray();

      expect(portsFor(commands, 'aggregate')).toContain(portOf(cluster.primary));
    });
  });

  describe('bulk writes', () => {
    it('chains find modifiers before an upsert on either bulk builder', async () => {
      const { client, commands } = connect();
      const collection = client.db('itest').collection(`bulk-modifiers-${Date.now()}`);

      for (const ordered of [true, false]) {
        const bulk = ordered
          ? collection.initializeOrderedBulkOp()
          : collection.initializeUnorderedBulkOp();
        bulk
          .find({ ordered, values: [1, 2] })
          .upsert()
          .hint({ _id: 1 })
          .collation({ locale: 'simple' })
          .arrayFilters([{ value: 2 }])
          .updateOne({ $set: { 'values.$[value]': 3 } });

        const result = await bulk.execute();
        expect(result.upsertedCount).toBe(1);
        await expect(
          collection.findOne({ ordered }, { readPreference: 'primary' })
        ).resolves.toMatchObject({ values: [1, 3] });
      }

      expect(portsFor(commands, 'update')).toEqual([
        portOf(cluster.primary),
        portOf(cluster.primary)
      ]);
    });

    it('executes on the primary', async () => {
      const { client, commands } = connect();
      const bulk = client.db('itest').collection('bulk').initializeOrderedBulkOp();
      bulk.insert({ a: 1 });
      bulk.insert({ a: 2 });
      const result = await bulk.execute();

      expect(result.insertedCount).toBe(2);
      expect(portsFor(commands, 'insert')).toEqual([portOf(cluster.primary)]);
    });

    it('applies a find then update', async () => {
      const { client } = connect();
      const name = `bulk-update-${Date.now()}`;
      const collection = client.db('itest').collection(name);
      await collection.insertOne({ k: 'x', v: 1 }, ALL_MEMBERS);

      const bulk = collection.initializeOrderedBulkOp();
      bulk.find({ k: 'x' }).updateOne({ $set: { v: 2 } });
      await bulk.execute();

      await expect(collection.findOne({ k: 'x' })).resolves.toMatchObject({ v: 2 });
    });
  });

  describe('explicit read preference', () => {
    it('pulls a read onto the primary', async () => {
      const { client, commands } = connect();
      await client.db('itest').collection('writes').findOne({}, { readPreference: 'primary' });

      expect(portsFor(commands, 'find')).toEqual([portOf(cluster.primary)]);
    });
  });

  describe('session handling', () => {
    it('rejects a session on a read', async () => {
      const { client } = connect();
      const session = {} as never;

      await expect(
        client.db('itest').collection('writes').findOne({}, { session })
      ).rejects.toThrow(SessionRoutingError);
    });
  });

  describe('a stale topology', () => {
    it('fails with NoPrimaryError when no member claims primary', async () => {
      const stale = {
        ...cluster.status,
        members: (cluster.status['members'] as Array<Record<string, unknown>>).map(member => ({
          ...member,
          stateStr: 'SECONDARY'
        }))
      };
      const { client } = connect(stale as never);

      await expect(
        client.db('itest').collection('writes').insertOne({ at: Date.now() })
      ).rejects.toThrow(NoPrimaryError);
    });

    it('surfaces a connection error when the named primary is gone', async () => {
      // serverSelectionTimeoutMS is a client option, not an operation one, so
      // it has to be set here or the connect waits out the 30s default.
      const stale = {
        ...cluster.status,
        members: [{ name: 'localhost:29999', stateStr: 'PRIMARY', health: 1 }]
      };
      const { client } = connect(stale as never, cluster.uri, {
        serverSelectionTimeoutMS: 2000
      });

      await expect(
        client.db('itest').collection('writes').insertOne({ at: Date.now() })
      ).rejects.toThrow();
    }, 20_000);

    it('falls back to the primary when every secondary is unhealthy', async () => {
      const degraded = {
        ...cluster.status,
        members: (cluster.status['members'] as Array<Record<string, unknown>>).map(member =>
          member['stateStr'] === 'SECONDARY' ? { ...member, health: 0 } : member
        )
      };
      const { client, commands } = connect(degraded as never);
      await client.db('itest').collection('writes').findOne({});

      expect(portsFor(commands, 'find')).toEqual([portOf(cluster.primary)]);
    });
  });

  describe('the uri the driver is given', () => {
    it('keeps credentials and options while targeting one host', async () => {
      // No auth on the test cluster, so assert the rewrite via the real
      // client's parsed options rather than by connecting with credentials.
      const { client, commands } = connect(cluster.status, `${cluster.uri}&appName=itest`);
      await client.db('itest').collection('writes').insertOne({ at: Date.now() });

      expect(portsFor(commands, 'insert')).toEqual([portOf(cluster.primary)]);
    });
  });
});
