import { MongoClient, ObjectId, type MongoClientOptions, type ConnectionReadyEvent } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { ServerlessMongoClient } from '../src/client.js';
import { TestPlugin } from './harness/plugin.js';

it.each(['read', 'write'] as const)('attaches the listener for a %s-only client', async operation => {
  const plugin = new TestPlugin({
    set: 'events',
    members: [
      { name: 'localhost:27017', stateStr: 'PRIMARY', health: 1 },
      { name: 'localhost:27018', stateStr: 'SECONDARY', health: 1 }
    ]
  });

  const port = operation === 'read' ? 27018 : 27017;
  const native = new MongoClient(`mongodb://localhost:${port}/events`);
  const database = native.db('events');
  const collection = database.collection('documents');
  const opened = vi.fn();

  vi.spyOn(collection, 'findOne').mockResolvedValue(null);
  vi.spyOn(collection, 'insertOne').mockResolvedValue({ acknowledged: true, insertedId: new ObjectId() });
  vi.spyOn(database, 'collection').mockReturnValue(collection);
  vi.spyOn(native, 'db').mockReturnValue(database);
  vi.spyOn(native, 'connect').mockImplementation(async () => {
    native.emit('open', native);

    return native;
  });
  vi.spyOn(native, 'close').mockResolvedValue();

  const client = new ServerlessMongoClient('mongodb://localhost:27017/events', {
    plugin, createClient: () => native, on: { open: opened }
  });

  try {
    const documents = client.db('events').collection('documents');

    if (operation === 'read') await documents.findOne({});
    else await documents.insertOne({ value: 1 });
    expect(opened).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledWith(native);
    expect(native.listeners('open')).toEqual([opened]);
  } finally {
    await client.close();
  }
});

it('connects, runs an operation and closes when on is omitted', async () => {
  const plugin = new TestPlugin({
    set: 'events',
    members: [{ name: 'localhost:27017', stateStr: 'PRIMARY', health: 1 }]
  });

  const native = new MongoClient('mongodb://localhost:27017/events');
  const database = native.db('events');
  const collection = database.collection('documents');
  const find = vi.spyOn(collection, 'findOne').mockResolvedValue(null);
  const connect = vi.spyOn(native, 'connect').mockResolvedValue(native);
  const close = vi.spyOn(native, 'close').mockResolvedValue();
  const on = vi.spyOn(native, 'on');

  vi.spyOn(database, 'collection').mockReturnValue(collection);
  vi.spyOn(native, 'db').mockReturnValue(database);

  const client = new ServerlessMongoClient('mongodb://localhost:27017/events', {
    plugin, createClient: () => native
  });

  try {
    await expect(client.db('events').collection('documents').findOne({})).resolves.toBeNull();
    expect(connect).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledWith({});
    expect(on).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }

  expect(close).toHaveBeenCalledOnce();
});

it('attaches constructor listeners directly to each native client before it connects', async () => {
  const plugin = new TestPlugin({
    set: 'events',
    members: [
      { name: 'localhost:27017', stateStr: 'PRIMARY', health: 1 },
      { name: 'localhost:27018', stateStr: 'SECONDARY', health: 1 }
    ]
  });

  const natives: MongoClient[] = [];
  const payloads: ConnectionReadyEvent[] = [];
  const ready = vi.fn();
  const closed = vi.fn();

  const factory = vi.fn((uri: string, options?: MongoClientOptions) => {
    const native = new MongoClient(uri, options);
    const collection = native.db('events').collection('documents');

    const payload: ConnectionReadyEvent = {
      address: native.options.hosts[0]!.toString(), connectionId: 1, durationMS: 2, time: new Date()
    };

    vi.spyOn(collection, 'findOne').mockResolvedValue(null);
    vi.spyOn(collection, 'insertOne').mockResolvedValue({ acknowledged: true, insertedId: new ObjectId() });
    const database = native.db('events');

    vi.spyOn(database, 'collection').mockReturnValue(collection);
    vi.spyOn(native, 'db').mockReturnValue(database);
    vi.spyOn(native, 'connect').mockImplementation(async () => {
      expect(native.listeners('connectionReady')).toEqual([ready]);
      native.emit('connectionReady', payload);
      native.emit('open', native);

      return native;
    });
    vi.spyOn(native, 'close').mockImplementation(async () => { native.emit('close'); });
    natives.push(native);
    payloads.push(payload);

    return native;
  });

  const client = new ServerlessMongoClient('mongodb://localhost:27017/events', {
    plugin, createClient: factory, monitorCommands: true,
    on: {
      connectionReady: ready,
      close: closed,
      open(this: MongoClient, client) {
        expect(this).toBe(client);
      }
    }
  });

  expect(factory).not.toHaveBeenCalled();
  expect(plugin.reads).toBe(0);

  try {
    await client.db('events').collection('documents').findOne({});
    expect(factory).toHaveBeenCalledTimes(1);
    await client.db('events').collection('documents').insertOne({ value: 1 });
    expect(factory).toHaveBeenCalledTimes(2);
    await client.db('events').collection('documents').findOne({});
    expect(factory).toHaveBeenCalledTimes(2);
    expect(ready.mock.calls).toEqual(payloads.map(payload => [payload]));
    expect(ready.mock.calls[0]![0]).toBe(payloads[0]);
    expect(ready.mock.contexts).toEqual(natives);

    for (const [, options] of factory.mock.calls) {
      expect(options).not.toHaveProperty('on');
      expect(options?.monitorCommands).toBe(true);
    }
  } finally {
    await client.close();
  }

  expect(closed.mock.calls).toEqual([[], []]);
});
