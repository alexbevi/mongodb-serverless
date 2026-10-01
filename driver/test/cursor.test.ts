import { describe, expect, it, vi } from 'vitest';
import { ServerlessMongoClient } from '../src/client.js';
import { UnsupportedOperationError } from '../src/errors.js';
import type { ReplSetGetStatus, TopologyPlugin } from '../src/plugin.js';

const topology: ReplSetGetStatus = {
  set: 'rs0',
  members: [
    { name: 'primary:27017', stateStr: 'PRIMARY', health: 1 },
    { name: 'secondary:27017', stateStr: 'SECONDARY', health: 1 }
  ]
};

const plugin: TopologyPlugin = {
  name: 'stub',
  version: '1.0.0',
  author: 'test',
  setup: async () => {},
  verify: async () => {},
  read: async () => topology,
  write: async () => {}
};

/**
 * A fake cursor that records the chain applied to it, so a test can assert
 * which calls were replayed and in what order.
 */
class FakeCursor {
  readonly chain: string[] = [];
  constructor(
    readonly host: string,
    readonly docs: unknown[]
  ) {}

  sort(spec: unknown): this {
    this.chain.push(`sort:${JSON.stringify(spec)}`);
    return this;
  }
  limit(n: number): this {
    this.chain.push(`limit:${n}`);
    return this;
  }
  skip(n: number): this {
    this.chain.push(`skip:${n}`);
    return this;
  }
  project(spec: unknown): this {
    this.chain.push(`project:${JSON.stringify(spec)}`);
    return this;
  }
  async toArray(): Promise<unknown[]> {
    return this.docs;
  }
  async next(): Promise<unknown> {
    return this.docs[0];
  }
  async hasNext(): Promise<boolean> {
    return this.docs.length > 0;
  }
  async forEach(fn: (doc: unknown) => void): Promise<void> {
    this.docs.forEach(fn);
  }
  async close(): Promise<void> {
    this.chain.push('close');
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    yield* this.docs;
  }
}

const setup = (docs: unknown[] = [{ a: 1 }, { a: 2 }]) => {
  const cursors: FakeCursor[] = [];

  const create = vi.fn((uri: string) => {
    const host = new URL(uri.replace('mongodb://', 'http://')).host;
    const makeCursor = () => {
      const cursor = new FakeCursor(host, docs);
      cursors.push(cursor);
      return cursor;
    };

    return {
      db: () => ({
        collection: () => ({
          find: vi.fn(makeCursor),
          aggregate: vi.fn(makeCursor),
          listIndexes: vi.fn(makeCursor),
          listSearchIndexes: vi.fn(makeCursor)
        }),
        listCollections: vi.fn(makeCursor),
        aggregate: vi.fn(makeCursor)
      }),
      close: vi.fn(async () => {})
    } as never;
  });

  const client = new ServerlessMongoClient('mongodb://seed:27017/app', {
    plugin,
    createClient: create
  });

  return { client, cursors, create };
};

describe('cursor routing', () => {
  it('creates no cursor until a terminal call', () => {
    const { client, create } = setup();
    client.db('app').collection('users').find({ a: 1 });

    expect(create).not.toHaveBeenCalled();
  });

  it('resolves find on the read client', async () => {
    const { client, cursors } = setup();
    await client.db('app').collection('users').find({}).toArray();

    expect(cursors[0]?.host).toBe('secondary:27017');
  });

  it('returns documents from toArray', async () => {
    const { client } = setup([{ a: 1 }]);

    await expect(client.db('app').collection('users').find({}).toArray()).resolves.toEqual([
      { a: 1 }
    ]);
  });

  it('replays a chained call before the terminal one', async () => {
    const { client, cursors } = setup();
    await client.db('app').collection('users').find({}).sort({ a: 1 }).toArray();

    expect(cursors[0]?.chain).toEqual(['sort:{"a":1}']);
  });

  it('replays a chain in order', async () => {
    const { client, cursors } = setup();
    await client
      .db('app')
      .collection('users')
      .find({})
      .sort({ a: 1 })
      .skip(5)
      .limit(10)
      .project({ a: 1 })
      .toArray();

    expect(cursors[0]?.chain).toEqual([
      'sort:{"a":1}',
      'skip:5',
      'limit:10',
      'project:{"a":1}'
    ]);
  });

  it('returns the proxy from a chained call, not the real cursor', () => {
    const { client } = setup();
    const cursor = client.db('app').collection('users').find({});

    expect(cursor.sort({ a: 1 })).toBe(cursor);
  });

  it('supports next', async () => {
    const { client } = setup([{ a: 7 }]);

    await expect(client.db('app').collection('users').find({}).next()).resolves.toEqual({ a: 7 });
  });

  it('supports hasNext', async () => {
    const { client } = setup([]);

    await expect(client.db('app').collection('users').find({}).hasNext()).resolves.toBe(false);
  });

  it('supports forEach', async () => {
    const { client } = setup([{ a: 1 }, { a: 2 }]);
    const seen: unknown[] = [];
    await client
      .db('app')
      .collection('users')
      .find({})
      .forEach(doc => void seen.push(doc));

    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('supports for await', async () => {
    const { client } = setup([{ a: 1 }, { a: 2 }]);
    const seen: unknown[] = [];

    for await (const doc of client.db('app').collection('users').find({})) {
      seen.push(doc);
    }

    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('creates the cursor once across several terminal calls', async () => {
    const { client, cursors } = setup();
    const cursor = client.db('app').collection('users').find({});
    await cursor.next();
    await cursor.toArray();

    expect(cursors).toHaveLength(1);
  });

  it('closes without creating a cursor', async () => {
    const { client, create } = setup();
    await client.db('app').collection('users').find({}).close();

    expect(create).not.toHaveBeenCalled();
  });

  it('routes an aggregate with no write stage to the read client', async () => {
    const { client, cursors } = setup();
    await client.db('app').collection('users').aggregate([{ $match: {} }]).toArray();

    expect(cursors[0]?.host).toBe('secondary:27017');
  });

  it('routes an aggregate ending in $out to the write client', async () => {
    const { client, cursors } = setup();
    await client
      .db('app')
      .collection('users')
      .aggregate([{ $match: {} }, { $out: 'dest' }])
      .toArray();

    expect(cursors[0]?.host).toBe('primary:27017');
  });

  it('routes listIndexes to the read client', async () => {
    const { client, cursors } = setup();
    await client.db('app').collection('users').listIndexes().toArray();

    expect(cursors[0]?.host).toBe('secondary:27017');
  });

  it('routes db.listCollections to the read client', async () => {
    const { client, cursors } = setup();
    await client.db('app').listCollections().toArray();

    expect(cursors[0]?.host).toBe('secondary:27017');
  });

  it('honours an explicit primary read preference on find', async () => {
    const { client, cursors } = setup();
    await client.db('app').collection('users').find({}, { readPreference: 'primary' }).toArray();

    expect(cursors[0]?.host).toBe('primary:27017');
  });

  it('still rejects watch', () => {
    const { client } = setup();

    expect(() => client.db('app').collection('users').watch()).toThrow(UnsupportedOperationError);
  });

  it('rejects an unknown cursor member', () => {
    const { client } = setup();
    const cursor = client.db('app').collection('users').find({}) as unknown as Record<
      string,
      unknown
    >;

    expect(() => cursor['nonsense']).toThrow(/nonsense/);
  });
});
