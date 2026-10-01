import { describe, expect, it, vi } from 'vitest';
import { ClientPair } from '../src/clients.js';
import { NoPrimaryError, NoTopologyError } from '../src/errors.js';
import type { ReplSetGetStatus, TopologyPlugin } from '../src/plugin.js';

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
  read: vi.fn(async () => status as ReplSetGetStatus),
  write: vi.fn(async () => {})
});

/** Records the uri each client was built with, so routing is observable. */
const factory = () => {
  const built: string[] = [];
  const closed: string[] = [];
  const connected: string[] = [];
  const create = vi.fn((uri: string) => {
    built.push(uri);
    return {
      uri,
      connect: vi.fn(async function (this: unknown) {
        connected.push(uri);
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

  it('surfaces NoTopologyError when the plugin returns nothing', async () => {
    const { pair } = pairFor(null);

    await expect(pair.write()).rejects.toThrow(NoTopologyError);
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
