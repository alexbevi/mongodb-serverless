import { describe, expect, it, vi } from 'vitest';
import { ServerlessMongoClient } from '../src/client.js';
import { SessionRoutingError, UnsupportedOperationError } from '../src/errors.js';
import type { ReplSetGetStatus, TopologyPlugin } from '../src/plugin.js';

const topology: ReplSetGetStatus = {
  set: 'rs0',
  members: [
    { name: 'primary:27017', stateStr: 'PRIMARY', health: 1 },
    { name: 'secondary:27017', stateStr: 'SECONDARY', health: 1 }
  ]
};

const plugin = (status: ReplSetGetStatus = topology): TopologyPlugin => ({
  name: 'stub',
  version: '1.0.0',
  author: 'test',
  setup: async () => {},
  verify: async () => {},
  read: async () => status,
  write: async () => {}
});

/**
 * A fake client that records every call as `host dbName.collName.method`, so a
 * test asserts routing by reading the host back.
 */
const fakeClients = () => {
  const calls: string[] = [];
  const closed: string[] = [];

  const create = vi.fn((uri: string) => {
    const host = new URL(uri.replace('mongodb://', 'http://')).host;

    const collection = (dbName: string, name: string): unknown =>
      new Proxy(
        {},
        {
          get: (_t, method: string) => (...args: unknown[]) => {
            calls.push(`${host} ${dbName}.${name}.${method}`);
            return Promise.resolve({ host, method, args });
          }
        }
      );

    const db = (dbName: string): unknown => ({
      databaseName: dbName,
      collection: (name: string) => collection(dbName, name),
      command: (...args: unknown[]) => {
        calls.push(`${host} ${dbName}.command`);
        return Promise.resolve({ host, args });
      },
      dropDatabase: () => {
        calls.push(`${host} ${dbName}.dropDatabase`);
        return Promise.resolve(true);
      }
    });

    return {
      db: vi.fn(db),
      connect: vi.fn(async function (this: unknown) {
        return this;
      }),
      close: vi.fn(async () => void closed.push(host))
    } as never;
  });

  return { calls, closed, create };
};

const clientFor = (status: ReplSetGetStatus = topology) => {
  const fake = fakeClients();
  const client = new ServerlessMongoClient('mongodb://seed:27017/', {
    plugin: plugin(status),
    createClient: fake.create
  });
  return { ...fake, client };
};

describe('ServerlessMongoClient', () => {
  it('sends a write to the primary', async () => {
    const { client, calls } = clientFor();
    await client.db('app').collection('users').insertOne({ a: 1 });

    expect(calls).toEqual(['primary:27017 app.users.insertOne']);
  });

  it('sends a read to the secondary', async () => {
    const { client, calls } = clientFor();
    await client.db('app').collection('users').findOne({ a: 1 });

    expect(calls).toEqual(['secondary:27017 app.users.findOne']);
  });

  it('passes arguments through untouched', async () => {
    const { client } = clientFor();
    const filter = { a: 1 };
    const options = { upsert: true };
    const result = (await client
      .db('app')
      .collection('users')
      .updateOne(filter, { $set: { b: 2 } }, options)) as { args: unknown[] };

    expect(result.args).toEqual([filter, { $set: { b: 2 } }, options]);
  });

  it('routes each operation independently', async () => {
    const { client, calls } = clientFor();
    const users = client.db('app').collection('users');
    await users.insertOne({ a: 1 });
    await users.countDocuments();
    await users.deleteOne({ a: 1 });

    expect(calls).toEqual([
      'primary:27017 app.users.insertOne',
      'secondary:27017 app.users.countDocuments',
      'primary:27017 app.users.deleteOne'
    ]);
  });

  it('honours an explicit primary read preference', async () => {
    const { client, calls } = clientFor();
    await client.db('app').collection('users').findOne({}, { readPreference: 'primary' });

    expect(calls).toEqual(['primary:27017 app.users.findOne']);
  });

  it('routes db-level writes to the primary', async () => {
    const { client, calls } = clientFor();
    await client.db('app').dropDatabase();

    expect(calls).toEqual(['primary:27017 app.dropDatabase']);
  });

  it('routes an arbitrary command to the primary', async () => {
    const { client, calls } = clientFor();
    await client.db('app').command({ ping: 1 });

    expect(calls).toEqual(['primary:27017 app.command']);
  });

  it('exposes the database name without connecting', () => {
    const { client, create } = clientFor();

    expect(client.db('app').databaseName).toBe('app');
    expect(create).not.toHaveBeenCalled();
  });

  it('exposes collection identity without connecting', () => {
    const { client, create } = clientFor();
    const users = client.db('app').collection('users');

    expect(users.collectionName).toBe('users');
    expect(users.dbName).toBe('app');
    expect(users.namespace).toBe('app.users');
    expect(create).not.toHaveBeenCalled();
  });

  it('uses the default database from the uri', async () => {
    const fake = fakeClients();
    const client = new ServerlessMongoClient('mongodb://seed:27017/mydb', {
      plugin: plugin(),
      createClient: fake.create
    });
    await client.db().collection('users').insertOne({});

    expect(fake.calls).toEqual(['primary:27017 mydb.users.insertOne']);
  });

  it('connect resolves without building a client', async () => {
    const { client, create } = clientFor();

    await expect(client.connect()).resolves.toBe(client);
    expect(create).not.toHaveBeenCalled();
  });

  it('closes every client it opened', async () => {
    const { client, closed } = clientFor();
    await client.db('app').collection('users').insertOne({});
    await client.db('app').collection('users').findOne({});
    await client.close();

    expect(closed.sort()).toEqual(['primary:27017', 'secondary:27017']);
  });

  describe('sessions', () => {
    it('rejects a session on a read-routed operation', async () => {
      // The driver rejects a session used with a different client, so a read
      // cannot borrow one created by the write client.
      const { client } = clientFor();
      const session = { id: 1 } as never;

      await expect(
        client.db('app').collection('users').findOne({}, { session })
      ).rejects.toThrow(SessionRoutingError);
    });

    it('explains the cause', async () => {
      const { client } = clientFor();

      await expect(
        client.db('app').collection('users').findOne({}, { session: {} as never })
      ).rejects.toThrow(/same MongoClient|primary/i);
    });

    it('allows a session on a write', async () => {
      const { client, calls } = clientFor();
      await client.db('app').collection('users').insertOne({}, { session: {} as never });

      expect(calls).toEqual(['primary:27017 app.users.insertOne']);
    });

    it('ignores a null session', async () => {
      const { client, calls } = clientFor();
      await client.db('app').collection('users').findOne({}, { session: undefined });

      expect(calls).toEqual(['secondary:27017 app.users.findOne']);
    });
  });

  describe('unsupported operations', () => {
    it('rejects collection.watch', () => {
      const { client } = clientFor();

      expect(() => client.db('app').collection('users').watch()).toThrow(
        UnsupportedOperationError
      );
    });

    it('rejects db.watch', () => {
      const { client } = clientFor();

      expect(() => client.db('app').watch()).toThrow(UnsupportedOperationError);
    });

    it('rejects client.watch', () => {
      const { client } = clientFor();

      expect(() => client.watch()).toThrow(UnsupportedOperationError);
    });

    it('rejects startSession', () => {
      const { client } = clientFor();

      expect(() => client.startSession()).toThrow(UnsupportedOperationError);
    });

    it('names change streams as out of scope', () => {
      const { client } = clientFor();

      expect(() => client.db('app').collection('users').watch()).toThrow(/change stream/i);
    });
  });

  it('throws on an unknown collection member', () => {
    const { client } = clientFor();
    const users = client.db('app').collection('users') as unknown as Record<string, unknown>;

    expect(() => users['somethingNew']).toThrow(/somethingNew/);
  });

  it('surfaces a topology failure on first use', async () => {
    const { client } = clientFor({ members: [{ name: 'b:27017', stateStr: 'SECONDARY', health: 1 }] });

    await expect(client.db('app').collection('users').insertOne({})).rejects.toThrow(/PRIMARY/);
  });
});
