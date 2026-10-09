import type { Document, FindOperators, MongoClient } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { ServerlessMongoClient } from '../src/client.js';
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

/** Mirrors the driver's builder: chainable calls, then an awaited execute. */
class FakeBulkOp {
  readonly ops: string[] = [];
  constructor(
    readonly host: string,
    readonly ordered: boolean
  ) {}

  insert(doc: Document): this {
    this.ops.push(`insert:${JSON.stringify(doc)}`);

    return this;
  }

  find(filter: Document) {
    this.ops.push(`find:${JSON.stringify(filter)}`);

    return {
      updateOne: (update: Parameters<FindOperators['updateOne']>[0]) => {
        this.ops.push(`updateOne:${JSON.stringify(update)}`);

        return this;
      },
      delete: () => {
        this.ops.push('delete');

        return this;
      }
    };
  }

  async execute(): Promise<{ host: string; ops: string[] }> {
    return { host: this.host, ops: this.ops };
  }
}

const setup = () => {
  const builders: FakeBulkOp[] = [];

  const create = vi.fn((uri: string) => {
    const host = new URL(uri.replace('mongodb://', 'http://')).host;

    const build = (ordered: boolean) => () => {
      const builder = new FakeBulkOp(host, ordered);
      builders.push(builder);

      return builder;
    };

    // SAFETY: This fake implements the client operations exercised here; the suite never reads MongoClient internals.
    return {
      db: () => ({
        collection: () => ({
          initializeOrderedBulkOp: vi.fn(build(true)),
          initializeUnorderedBulkOp: vi.fn(build(false))
        })
      }),
      connect: vi.fn(async function (this: MongoClient) {
        return this;
      }),
      close: vi.fn(async () => {})
    } as never;
  });

  const client = new ServerlessMongoClient('mongodb://seed:27017/app', {
    plugin,
    createClient: create
  });

  return { client, builders, create };
};

describe('bulk write builders', () => {
  it('resolves on the write client', async () => {
    const { client, builders } = setup();
    await client.db('app').collection('users').initializeOrderedBulkOp().execute();

    expect(builders[0]?.host).toBe('primary:27017');
  });

  it('routes the unordered builder to the write client', async () => {
    const { client, builders } = setup();
    await client.db('app').collection('users').initializeUnorderedBulkOp().execute();

    expect(builders[0]?.host).toBe('primary:27017');
  });

  it('keeps the ordered and unordered builders distinct', async () => {
    const { client, builders } = setup();
    await client.db('app').collection('users').initializeOrderedBulkOp().execute();
    await client.db('app').collection('users').initializeUnorderedBulkOp().execute();

    expect(builders.map(b => b.ordered)).toEqual([true, false]);
  });

  it('builds nothing until execute', () => {
    const { client, create } = setup();
    client.db('app').collection('users').initializeOrderedBulkOp();

    expect(create).not.toHaveBeenCalled();
  });

  it('replays a buffered insert', async () => {
    const { client, builders } = setup();
    await client
      .db('app')
      .collection('users')
      .initializeOrderedBulkOp()
      .insert({ a: 1 })
      .execute();

    expect(builders[0]?.ops).toEqual(['insert:{"a":1}']);
  });

  it('replays several operations in order', async () => {
    const { client, builders } = setup();
    await client
      .db('app')
      .collection('users')
      .initializeOrderedBulkOp()
      .insert({ a: 1 })
      .insert({ a: 2 })
      .execute();

    expect(builders[0]?.ops).toEqual(['insert:{"a":1}', 'insert:{"a":2}']);
  });

  it('returns the result of execute', async () => {
    const { client } = setup();

    const result = await client
      .db('app')
      .collection('users')
      .initializeOrderedBulkOp()
      .insert({ a: 1 })
      .execute();

    expect(result).toMatchObject({ host: 'primary:27017' });
  });

  it('supports the find sub-builder', async () => {
    const { client, builders } = setup();
    const bulk = client.db('app').collection('users').initializeOrderedBulkOp();
    bulk.find({ a: 1 }).updateOne({ $set: { b: 2 } });
    await bulk.execute();

    expect(builders[0]?.ops).toEqual(['find:{"a":1}', 'updateOne:{"$set":{"b":2}}']);
  });

  it('supports find then delete', async () => {
    const { client, builders } = setup();
    const bulk = client.db('app').collection('users').initializeOrderedBulkOp();
    bulk.find({ a: 1 }).delete();
    await bulk.execute();

    expect(builders[0]?.ops).toEqual(['find:{"a":1}', 'delete']);
  });

  it('interleaves insert and find in order', async () => {
    const { client, builders } = setup();
    const bulk = client.db('app').collection('users').initializeOrderedBulkOp();
    bulk.insert({ a: 1 });
    bulk.find({ a: 2 }).delete();
    bulk.insert({ a: 3 });
    await bulk.execute();

    expect(builders[0]?.ops).toEqual([
      'insert:{"a":1}',
      'find:{"a":2}',
      'delete',
      'insert:{"a":3}'
    ]);
  });

  it('builds one builder across repeated execute calls', async () => {
    const { client, builders } = setup();
    const bulk = client.db('app').collection('users').initializeOrderedBulkOp();
    await bulk.execute();
    await bulk.execute();

    expect(builders).toHaveLength(1);
  });

  it('rejects an unknown builder member', () => {
    const { client } = setup();

    const bulk = client.db('app').collection('users').initializeOrderedBulkOp();

    expect(() => {
      // @ts-expect-error Probe an unsupported member from a JavaScript caller.
      return bulk.nonsense;
    }).toThrow(/nonsense/);
  });
});
