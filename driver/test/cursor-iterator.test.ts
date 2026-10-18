import { MongoClient, MongoNetworkError, MongoServerError, type Document } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { createCursorProxy, type CursorSource } from '../src/cursor.js';
import { ClientPair } from '../src/clients.js';
import { createWriteExecutor, type WriteOperation } from '../src/recovery.js';
import { TestPlugin } from './harness/plugin.js';

const consume = async (cursor: AsyncIterable<Document>): Promise<void> => {
  for await (const document of cursor) {
    void document;
  }
};

function routedCursor(source: CursorSource<Document>, executeWrite: WriteOperation): AsyncIterable<Document> {
  // SAFETY: createCursorProxy exposes Symbol.asyncIterator through its proxy handler.
  return createCursorProxy(source, 'aggregate', executeWrite) as AsyncIterable<Document>;
}

it('preserves the native iteration error when cursor cleanup also fails', async () => {
  const client = new MongoClient('mongodb://localhost:27017');
  const iterationFailure = new MongoServerError({ code: 10107, message: 'not primary' });
  const cleanupFailure = new MongoNetworkError('connection lost during cursor cleanup');

  const makeCursor = () => {
    const cursor = client.db('test').collection('source').aggregate([{ $out: 'destination' }]);
    vi.spyOn(cursor, 'hasNext').mockResolvedValue(true);
    vi.spyOn(cursor, 'next').mockRejectedValue(iterationFailure);
    vi.spyOn(cursor, 'close').mockRejectedValue(cleanupFailure);

    return cursor;
  };

  const native = makeCursor();
  const routed = makeCursor();

  const proxy = routedCursor(async () => routed, operation => operation());

  try {
    await expect(consume(native)).rejects.toBe(iterationFailure);
    expect(native.close).toHaveBeenCalledOnce();
    await expect(consume(proxy)).rejects.toBe(iterationFailure);
  } finally {
    vi.restoreAllMocks();
    await client.close();
  }
});


it('delegates caller-thrown errors to the native iterator and closes once', async () => {
  const client = new MongoClient('mongodb://localhost:27017');
  const native = client.db('test').collection('source').aggregate([]);
  const failure = new Error('consumer stopped');
  vi.spyOn(native, 'next').mockResolvedValue({ n: 1 });
  vi.spyOn(native, 'close').mockResolvedValue();
  const iterator = routedCursor(async () => native, operation => operation())[Symbol.asyncIterator]();

  try {
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { n: 1 } });
    await expect(iterator.throw!(failure)).rejects.toBe(failure);
    expect(native.close).toHaveBeenCalledOnce();
    expect(native.next).toHaveBeenCalledOnce();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  } finally {
    vi.restoreAllMocks();
    await client.close();
  }
});

it('does not create a native cursor when an iterator is returned before its first next', async () => {
  const source = vi.fn(async () => { throw new Error('must remain lazy'); });
  const iterator = routedCursor(source, operation => operation())[Symbol.asyncIterator]();

  await expect(iterator.return!()).resolves.toEqual({ done: true, value: undefined });
  expect(source).not.toHaveBeenCalled();
});

it.each(['source', 'next'] as const)('refreshes once without replay when %s fails during iteration', async failureAt => {
  const client = new MongoClient('mongodb://localhost:27017');
  const native = client.db('test').collection('source').aggregate([{ $out: 'destination' }]);
  const failure = new MongoServerError({ code: 10107, message: 'not primary' });

  const clients = new ClientPair({
    uri: 'mongodb://localhost:27017',
    plugin: new TestPlugin({ members: [{ name: 'localhost:27017', stateStr: 'PRIMARY' }] }),
    createClient: () => client
  });

  const refresh = vi.spyOn(clients, 'refreshTopology').mockResolvedValue();
  vi.spyOn(native, 'next').mockRejectedValue(failure);

  const source = vi.fn(async () => {
    if (failureAt === 'source') throw failure;

    return native;
  });

  const proxy = routedCursor(source, createWriteExecutor(async () => clients));

  try {
    await expect(consume(proxy)).rejects.toBe(failure);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(0);
    expect(source).toHaveBeenCalledOnce();
    expect(native.next).toHaveBeenCalledTimes(failureAt === 'next' ? 1 : 0);
  } finally {
    vi.restoreAllMocks();
    await clients.close();
    await client.close();
  }
});
