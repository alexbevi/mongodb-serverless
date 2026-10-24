import { handshake } from './harness/handshake.js';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { ClientPair } from '../src/clients.js';
import { NoPrimaryError } from '../src/errors.js';
import { uncachedTopology, type ReplSetGetStatus, type TopologyPlugin } from '../src/plugin.js';

const threeNode: ReplSetGetStatus = {
  set: 'rs0',
  members: [
    { name: 'a:27017', stateStr: 'PRIMARY', health: 1 },
    { name: 'b:27017', stateStr: 'SECONDARY', health: 1 },
    { name: 'c:27017', stateStr: 'SECONDARY', health: 1 }
  ]
};

const singleNode: ReplSetGetStatus = {
  set: 'rs0',
  members: [{ name: 'a:27017', stateStr: 'PRIMARY', health: 1 }]
};

const pluginFor = (status: ReplSetGetStatus | null): TopologyPlugin => ({
  name: 'stub',
  version: '1.0.0',
  author: 'test',
  setup: vi.fn(async () => {}),
  verify: vi.fn(async () => {}),
  read: vi.fn(async () => status),
  write: vi.fn(async () => {})
});

/** Records the uri each client was built with, so routing is observable. */
const factory = () => {
  const built: string[] = [];
  const closed: string[] = [];
  const connected: string[] = [];

  const create = vi.fn((uri: string) => {
    built.push(uri);
    const hello = handshake(new URL(uri).hostname === 'a' ? 'RSPrimary' : 'RSSecondary');

    // SAFETY: This fake implements the client operations exercised here; the suite never reads MongoClient internals.
    return {
      on: hello.on,
      uri,
      connect: vi.fn(async function (this: MongoClient) {
        connected.push(uri);
        hello.connected();

        return this;
      }),
      close: vi.fn(async () => void closed.push(uri))
    } as never;
  });

  return { built, closed, connected, create };
};

const pairFor = (status: ReplSetGetStatus | null, uri = 'mongodb://seed:27017/') => {
  const f = factory();
  const pair = new ClientPair({ uri, plugin: pluginFor(status), createClient: f.create });

  return { ...f, pair };
};

describe('ClientPair', () => {
  it('builds nothing until a client is asked for', () => {
    const { built } = pairFor(threeNode);

    expect(built).toEqual([]);
  });

  it('points the write client at the primary', async () => {
    const { pair, built } = pairFor(threeNode);
    await pair.write();

    expect(built).toHaveLength(1);
    expect(built[0]).toContain('a:27017');
    expect(built[0]).toContain('directConnection=true');
  });

  it('points the read client at a secondary', async () => {
    const { pair, built } = pairFor(threeNode);
    await pair.read();

    expect(built[0]).toContain('b:27017');
  });

  it('picks the first healthy secondary', async () => {
    const status: ReplSetGetStatus = {
      members: [
        { name: 'a:27017', stateStr: 'PRIMARY', health: 1 },
        { name: 'b:27017', stateStr: 'SECONDARY', health: 0 },
        { name: 'c:27017', stateStr: 'SECONDARY', health: 1 }
      ]
    };

    const { pair, built } = pairFor(status);
    await pair.read();

    expect(built[0]).toContain('c:27017');
  });

  it('falls back to the primary when no secondary is healthy', async () => {
    const { pair, built } = pairFor(singleNode);
    await pair.read();

    expect(built[0]).toContain('a:27017');
  });

  it('connects each client it builds', async () => {
    // The driver's bulk write builders throw "MongoClient must be connected"
    // unless connect() has been awaited, so handing back an unconnected client
    // breaks initializeOrderedBulkOp as a first operation.
    const { pair, connected } = pairFor(threeNode);
    await pair.write();

    expect(connected).toHaveLength(1);
  });

  it('connects the read client too', async () => {
    const { pair, connected } = pairFor(threeNode);
    await pair.read();

    expect(connected).toHaveLength(1);
  });

  it('connects each client only once', async () => {
    const { pair, connected } = pairFor(threeNode);
    await pair.write();
    await pair.write();
    await pair.read();

    expect(connected).toHaveLength(2);
  });

  it('builds each client once', async () => {
    const { pair, create } = pairFor(threeNode);
    await pair.write();
    await pair.write();
    await pair.read();
    await pair.read();

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns the same instance on repeat calls', async () => {
    const { pair } = pairFor(threeNode);

    expect(await pair.write()).toBe(await pair.write());
  });

  it('builds the read and write clients separately', async () => {
    const { pair } = pairFor(threeNode);

    expect(await pair.read()).not.toBe(await pair.write());
  });

  it('shares one client when reads fall back to the primary', async () => {
    // Both target the same host, so a second connection would be waste.
    const { pair, create } = pairFor(singleNode);
    await pair.read();
    await pair.write();

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reads the plugin once for both clients', async () => {
    const plugin = pluginFor(threeNode);
    const f = factory();

    const pair = new ClientPair({
      uri: 'mongodb://seed:27017/',
      plugin,
      createClient: f.create
    });

    await pair.read();
    await pair.write();

    expect(plugin.read).toHaveBeenCalledTimes(1);
  });

  it('resolves concurrent requests to one client', async () => {
    const { pair, create } = pairFor(threeNode);
    const [one, two] = await Promise.all([pair.write(), pair.write()]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(one).toBe(two);
  });

  it('closes every client it built', async () => {
    const { pair, closed } = pairFor(threeNode);
    await pair.read();
    await pair.write();
    await pair.close();

    expect(closed).toHaveLength(2);
  });

  it('closes nothing when nothing was built', async () => {
    const { pair, closed } = pairFor(threeNode);
    await pair.close();

    expect(closed).toEqual([]);
  });

  it('is idempotent on close', async () => {
    const { pair, closed } = pairFor(threeNode);
    await pair.write();
    await pair.close();
    await pair.close();

    expect(closed).toHaveLength(1);
  });

  it('rejects use after close', async () => {
    const { pair } = pairFor(threeNode);
    await pair.close();

    await expect(pair.write()).rejects.toThrow(/closed/i);
  });

  it('surfaces NoPrimaryError from the topology', async () => {
    const { pair } = pairFor({ members: [{ name: 'b:27017', stateStr: 'SECONDARY', health: 1 }] });

    await expect(pair.write()).rejects.toThrow(NoPrimaryError);
  });

  it('does not cache a failed topology read', async () => {
    // A transient plugin failure should not poison the client for its lifetime.
    const plugin = pluginFor(threeNode);
    vi.mocked(plugin.read)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(threeNode);
    const f = factory();
    const pair = new ClientPair({ uri: 'mongodb://seed:27017/', plugin, createClient: f.create });

    await expect(pair.write()).rejects.toThrow('transient');
    await expect(pair.write()).resolves.toBeDefined();
  });

  it('preserves credentials from the original uri', async () => {
    const { pair, built } = pairFor(threeNode, 'mongodb://user:pass@seed:27017/db?appName=svc');
    await pair.write();

    expect(built[0]).toContain('user:pass@');
    expect(built[0]).toContain('appName=svc');
  });
});

it('keeps routed connections direct even when native options request discovery', async () => {
  const hello = handshake('RSPrimary');
  // SAFETY: This fake reports its handshake role and implements connection lifecycle.
  const createClient = vi.fn(() => ({ on: hello.on, async connect() { hello.connected(); }, async close() {} } as never));

  const pair = new ClientPair({
    uri: 'mongodb://seed:27017/', plugin: pluginFor(singleNode), createClient,
    driverOptions: { directConnection: false, retryWrites: true }
  });

  await pair.write();

  expect(createClient).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ directConnection: true }));
  await pair.close();
});

it.each([
  ['routed', pluginFor(singleNode)],
  ['bootstrap', uncachedTopology]
])('leaves retryable writes to the native driver on %s connections', async (_path, plugin) => {
  const hello = handshake('RSPrimary');
  // SAFETY: This fake reports its handshake role and implements connection lifecycle.
  const createClient = vi.fn((_uri: string, _options?: MongoClientOptions) => ({ on: hello.on, async connect() { hello.connected(); }, async close() {} } as never));

  const defaults = new ClientPair({ uri: 'mongodb://a:27017/', plugin, createClient });
  await defaults.write();
  await defaults.close();

  const optedOut = new ClientPair({ uri: 'mongodb://a:27017/', plugin, createClient, driverOptions: { retryWrites: false } });
  await optedOut.write();
  await optedOut.close();

  expect(createClient.mock.calls[0]?.[1]).not.toHaveProperty('retryWrites');
  expect(createClient.mock.calls[1]?.[1]).toMatchObject({ retryWrites: false });
});

it('waits for in-flight discovery on close and does not persist afterward', async () => {
  let release!: (status: ReplSetGetStatus) => void;
  let started!: () => void;
  const discovery = new Promise<ReplSetGetStatus>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const closed = vi.fn(async () => {});
  const plugin = pluginFor(null);
  const hello = handshake('RSPrimary');

  const pair = new ClientPair({
    uri: 'mongodb://a:27017/', plugin,
    // SAFETY: The fake blocks the status command to exercise close during discovery.
    createClient: () => ({
      options: {}, on: hello.on, async connect() { hello.connected(); }, close: closed,
      db: () => ({ command: async () => {
        started();

        return discovery;
      } })
    } as never)
  });

  const attempt = pair.write().catch(error => error);
  await ready;
  let finished = false;
  const closing = pair.close().then(() => { finished = true; });
  await Promise.resolve();
  await Promise.resolve();

  expect(finished).toBe(false);
  release(singleNode);
  await closing;
  expect(await attempt).toMatchObject({ message: expect.stringMatching(/closed/) });
  expect(closed).toHaveBeenCalledTimes(1);
  expect(plugin.write).not.toHaveBeenCalled();
});

it('closes a routed client when connection fails', async () => {
  const closed = vi.fn(async () => {});

  const pair = new ClientPair({
    uri: 'mongodb://a:27017/', plugin: pluginFor(singleNode),
    // SAFETY: This fake only exercises failed connection cleanup.
    createClient: () => ({ on() {}, async connect() { throw new Error('connect failed'); }, close: closed } as never)
  });

  await expect(pair.write()).rejects.toThrow('connect failed');
  expect(closed).toHaveBeenCalledTimes(1);
  await expect(pair.close()).resolves.toBeUndefined();
});


it('does not bootstrap a no-plugin client after it has closed', async () => {
  const createClient = vi.fn(() => { throw new Error('unexpected connection'); });
  const pair = new ClientPair({ uri: 'mongodb://a:27017/', plugin: uncachedTopology, createClient });
  await pair.close();

  await expect(pair.write()).rejects.toThrow(/closed/i);
  expect(createClient).not.toHaveBeenCalled();
});
