import type { Document, MongoClient } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { Watcher, type WatcherOptions } from '../src/watcher.js';
import { MissingPluginError, NotAReplicaSetError, PluginReadOnlyError } from '../src/errors.js';
import type { ReplSetGetStatus, TopologyPlugin } from '../../plugins/shared/src/index.js';

const status = {
  set: 'rs0',
  members: [
    { name: 'a:27017', stateStr: 'PRIMARY', health: 1 },
    { name: 'b:27017', stateStr: 'SECONDARY', health: 1 }
  ],
  ok: 1
};

const hello = { setName: 'rs0', hosts: ['a:27017', 'b:27017'], me: 'a:27017', ok: 1 };

/** Records what was written, so a test can assert the stored document. */
const recordingPlugin = (writable = true) => {
  const writes: ReplSetGetStatus[] = [];

  const plugin: TopologyPlugin = {
    name: 'recording',
    version: '1.0.0',
    author: 'test',
    setup: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
    read: vi.fn(async () => status),
    write: vi.fn(async (doc: ReplSetGetStatus) => {
      if (!writable) throw new PluginReadOnlyError('Plugin "recording" is read-only.');
      writes.push(doc);
    })
  };

  return { plugin, writes };
};

const fakeClient = () => {
  const client = {
    connect: vi.fn(async function (this: MongoClient) {
      return this;
    }),
    db: vi.fn(() => ({
      command: vi.fn(async (doc: Document) =>
        'hello' in doc ? hello : status
      )
    })),
    close: vi.fn(async () => {})
  };

  return client;
};

const watcherFor = (options: Partial<WatcherOptions> = {}) => {
  const { plugin, writes } = recordingPlugin();
  const client = fakeClient();

  const watcher = new Watcher({
    uri: 'mongodb://a:27017/?replicaSet=rs0',
    plugin,
    createClient: vi.fn(() => client as never),
    ...options
  });

  return { watcher, plugin, writes, client };
};

describe('Watcher.check', () => {
  it('writes the document the cluster reported', async () => {
    const { watcher, writes } = watcherFor();
    await watcher.check();
    await watcher.close();

    expect(writes).toEqual([status]);
  });

  it('reports what it did', async () => {
    const { watcher } = watcherFor();
    const result = await watcher.check();
    await watcher.close();

    expect(result).toMatchObject({ setName: 'rs0', members: 2 });
  });

  it('verifies the cluster before reading its topology', async () => {
    const seen: string[] = [];

    const client = {
      connect: vi.fn(async function (this: MongoClient) {
        return this;
      }),
      db: vi.fn(() => ({
        command: vi.fn(async (doc: Document) => {
          seen.push('hello' in doc ? 'hello' : 'status');

          return 'hello' in doc ? hello : status;
        })
      })),
      close: vi.fn(async () => {})
    };

    const { plugin } = recordingPlugin();

    const watcher = new Watcher({
      uri: 'mongodb://a:27017/',
      plugin,
      createClient: vi.fn(() => client as never)
    });

    await watcher.check();
    await watcher.close();

    expect(seen).toEqual(['hello', 'status']);
  });

  it('does not write when the cluster is not a replica set', async () => {
    const client = fakeClient();
    client.db = vi.fn(() => ({ command: vi.fn(async () => ({ ok: 1 })) })) as never;
    const { plugin, writes } = recordingPlugin();

    const watcher = new Watcher({
      uri: 'mongodb://a:27017/',
      plugin,
      createClient: vi.fn(() => client as never)
    });

    await expect(watcher.check()).rejects.toThrow(NotAReplicaSetError);
    expect(writes).toEqual([]);
    await watcher.close();
  });

  it('surfaces PluginReadOnlyError from a read-only plugin', async () => {
    const { plugin } = recordingPlugin(false);

    const watcher = new Watcher({
      uri: 'mongodb://a:27017/',
      plugin,
      createClient: vi.fn(() => fakeClient() as never)
    });

    await expect(watcher.check()).rejects.toThrow(PluginReadOnlyError);
    await watcher.close();
  });

  it('surfaces MissingPluginError when no plugin is configured', async () => {
    const watcher = new Watcher({
      uri: 'mongodb://a:27017/',
      createClient: vi.fn(() => fakeClient() as never)
    });

    await expect(watcher.check()).rejects.toThrow(MissingPluginError);
    await watcher.close();
  });

  it('reuses one connection across two checks', async () => {
    const { watcher, client } = watcherFor();
    await watcher.check();
    await watcher.check();
    await watcher.close();

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('resolves the plugin once', async () => {
    const { watcher, plugin } = watcherFor();
    await watcher.check();
    await watcher.check();
    await watcher.close();

    expect(plugin.write).toHaveBeenCalledTimes(2);
  });

  it('writes on every check, since the stored document always moves', async () => {
    // date and member uptime change every call, so there is nothing to diff.
    const { watcher, writes } = watcherFor();
    await watcher.check();
    await watcher.check();
    await watcher.close();

    expect(writes).toHaveLength(2);
  });
});

describe('Watcher.close', () => {
  it('closes the cluster connection', async () => {
    const { watcher, client } = watcherFor();
    await watcher.check();
    await watcher.close();

    expect(client.close).toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const { watcher } = watcherFor();
    await watcher.check();
    await watcher.close();

    await expect(watcher.close()).resolves.toBeUndefined();
  });

  it('closes without ever having checked', async () => {
    const { watcher, client } = watcherFor();
    await watcher.close();

    expect(client.close).not.toHaveBeenCalled();
  });
});
