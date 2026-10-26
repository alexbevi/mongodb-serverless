import { handshake } from './harness/handshake.js';
import { MongoServerError } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { createWriteExecutor } from '../src/recovery.js';
import { ServerlessMongoClient } from '../src/client.js';

const status = { set: 'rs0', members: [{ name: 'a:27017', stateStr: 'PRIMARY' }] };

it('refreshes topology when deferred cursor and bulk execution fail', async () => {
  const failure = new MongoServerError({ code: 10107, message: 'not primary' });
  const hello = handshake('RSPrimary');
  const write = vi.fn(async () => {});

  const plugin = {
    name: 'test', version: '1', author: 'test',
    async setup() {}, async verify() {}, async read() { return status; }, write
  };

  const client = new ServerlessMongoClient('mongodb://a:27017/db', {
    plugin,
    // SAFETY: This fake supplies the methods exercised by the failure paths below.
    createClient: () => ({
      options: {}, on: hello.on,
      async connect() { hello.connected(); }, async close() {},
      db: () => ({
        command: async (command: { hello?: number }) => command.hello ? { setName: 'rs0' } : status,
        collection: () => ({
          aggregate: () => ({ async toArray() { throw failure; }, async close() {} }),
          initializeOrderedBulkOp: () => ({ insert() {}, async execute() { throw failure; } })
        })
      })
    } as never)
  });

  await expect(client.db('db').collection('c').aggregate([{ $out: 'other' }]).toArray()).rejects.toBe(failure);
  expect(write).toHaveBeenCalledTimes(1);
  const bulk = client.db('db').collection('c').initializeOrderedBulkOp();
  bulk.insert({ value: 1 });

  await expect(bulk.execute()).rejects.toBe(failure);
  expect(write).toHaveBeenCalledTimes(2);
  await client.close();
});

it('uses cached members for refresh when the original seed is unavailable', async () => {
  const failure = new MongoServerError({ code: 10107, message: 'not primary' });
  const hello = handshake('RSPrimary');

  const plugin = {
    name: 'test', version: '1', author: 'test',
    async setup() {}, async verify() {}, async read() { return status; }, async write() {}
  };

  let attempts = 0;

  const client = new ServerlessMongoClient('mongodb://gone:27017/db', {
    plugin,
    // SAFETY: This fake exercises a dead seed and a cached member that can report topology.
    createClient: uri => ({
      options: {}, on: hello.on,
      async connect() {
        if (uri.includes('gone:')) throw new Error('seed gone');
        hello.connected();
      },
      async close() {},
      db: () => ({
        command: async (command: { hello?: number }) => command.hello ? { setName: 'rs0' } : status,
        collection: () => ({ async insertOne() {
          attempts += 1;

          if (attempts === 1) throw failure;

          return { acknowledged: true };
        } })
      })
    } as never)
  });

  await expect(client.db('db').collection('c').insertOne({})).resolves.toMatchObject({ acknowledged: true });
  expect(attempts).toBe(2);
  await client.close();
});

it('preserves unstructured plugin errors without masking them during classification', async () => {
  const { ClientPair } = await import('../src/clients.js');
  const failure = { errorLabels: 123, message: 'store failed' };

  const pair = new ClientPair({
    uri: 'mongodb://a:27017/',
    plugin: { name: 'test', version: '1', author: 'test', async setup() {}, async verify() {},
      async read() { throw failure; }, async write() {} },
    createClient: () => { throw new Error('must not connect'); }
  });

  const executeWrite = createWriteExecutor(async () => pair);

  await expect(executeWrite(() => pair.write())).rejects.toBe(failure);
});
