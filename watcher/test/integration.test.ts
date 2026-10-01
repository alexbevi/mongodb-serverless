import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient as RealMongoClient, type CommandStartedEvent } from 'mongodb';
import { Watcher } from '../src/watcher.js';
import { NotAReplicaSetError } from '../src/errors.js';
import { ServerlessMongoClient } from '../../driver/src/client.js';
import { LocalPlugin } from '../../plugins/local/src/index.js';
import {
  describeCluster,
  dockerAvailable,
  startCluster,
  startStandalone,
  stepDownPrimary,
  stopStandalone,
  STANDALONE_PORT,
  type TestCluster
} from '../../test/harness/cluster.js';

const hasDocker = await dockerAvailable();
const VAR = '__MONGODB_CLUSTER_TOPOLOGY';

/**
 * The watcher against a real replica set.
 *
 * Nothing here hand-populates the topology variable: the watcher discovers it,
 * and the driver then routes on nothing but what the watcher wrote.
 */
describe.skipIf(!hasDocker)('watcher against a real replica set', () => {
  let cluster: TestCluster;
  let saved: string | undefined;
  const open: Array<{ close: () => Promise<void> }> = [];

  beforeAll(async () => {
    await startCluster();
    cluster = await describeCluster();
  }, 180_000);

  beforeEach(() => {
    saved = process.env[VAR];
    delete process.env[VAR];
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map(c => c.close().catch(() => {})));

    if (saved == null) delete process.env[VAR];
    else process.env[VAR] = saved;
  });

  afterAll(async () => {
    // The cluster is left running; `pnpm cluster:stop` removes it.
  });

  const watcherFor = (uri = cluster.uri): Watcher => {
    const watcher = new Watcher({ uri, plugin: new LocalPlugin({ writable: true }) });
    open.push(watcher);
    return watcher;
  };

  const portOf = (hostPort: string): number => Number(hostPort.split(':').at(-1));

  it('writes a topology that matches the live cluster', async () => {
    const result = await watcherFor().check();

    expect(result.setName).toBe('rstest');
    expect(result.members).toBe(3);
  });

  it('stores the member names the cluster reports', async () => {
    await watcherFor().check();
    const stored = JSON.parse(process.env[VAR] as string) as {
      set: string;
      members: Array<{ name: string }>;
    };

    expect(stored.set).toBe('rstest');
    expect(stored.members.map(m => m.name).sort()).toEqual(
      [cluster.primary, ...cluster.secondaries].sort()
    );
  });

  it('records which member is primary', async () => {
    await watcherFor().check();
    const stored = JSON.parse(process.env[VAR] as string) as {
      members: Array<{ name: string; stateStr: string }>;
    };

    expect(stored.members.find(m => m.stateStr === 'PRIMARY')?.name).toBe(cluster.primary);
  });

  it('rejects a connection string pointing at nothing', async () => {
    // Capped, or the driver waits out its 30s server selection default.
    const watcher = new Watcher({
      uri: 'mongodb://localhost:29998/',
      plugin: new LocalPlugin({ writable: true }),
      driverOptions: { serverSelectionTimeoutMS: 2000 }
    });
    open.push(watcher);

    await expect(watcher.check()).rejects.toThrow(/cannot reach/i);
  }, 30_000);

  it('refuses to write through a read-only plugin', async () => {
    const watcher = new Watcher({ uri: cluster.uri, plugin: new LocalPlugin() });
    open.push(watcher);

    await expect(watcher.check()).rejects.toThrow(/read-only/i);
    expect(process.env[VAR]).toBeUndefined();
  });

  describe('end to end with the driver', () => {
    it('routes on nothing but what the watcher wrote', async () => {
      // The variable starts unset, so a routing success proves the watcher
      // supplied the whole topology.
      expect(process.env[VAR]).toBeUndefined();
      await watcherFor().check();

      const commands: CommandStartedEvent[] = [];
      const client = new ServerlessMongoClient(cluster.uri, {
        plugin: new LocalPlugin(),
        monitorCommands: true,
        createClient: (uri, options) => {
          const real = new RealMongoClient(uri, options);
          real.on('commandStarted', event => commands.push(event));
          return real;
        }
      });
      open.push(client);

      const collection = client.db('watcher-e2e').collection('c');
      await collection.insertOne({ at: Date.now() }, { writeConcern: { w: 3 } });
      await collection.findOne({});

      const portsFor = (name: string): number[] =>
        commands
          .filter(event => event.commandName === name)
          .map(event => Number(event.address.split(':').at(-1)));

      expect(portsFor('insert')).toEqual([portOf(cluster.primary)]);
      expect(cluster.secondaries.map(portOf)).toContain(portsFor('find')[0]);
    }, 60_000);
  });

  describe('after a failover', () => {
    it('records the new primary', async () => {
      const watcher = watcherFor();
      const before = await watcher.check();
      const original = JSON.parse(process.env[VAR] as string) as {
        members: Array<{ name: string; stateStr: string }>;
      };
      const originalPrimary = original.members.find(m => m.stateStr === 'PRIMARY')?.name;

      await stepDownPrimary();
      await watcher.check();

      const updated = JSON.parse(process.env[VAR] as string) as {
        members: Array<{ name: string; stateStr: string }>;
      };
      const newPrimary = updated.members.find(m => m.stateStr === 'PRIMARY')?.name;

      expect(before.setName).toBe('rstest');
      expect(newPrimary).toBeDefined();
      expect(newPrimary).not.toBe(originalPrimary);

      // Leave the cluster as the other suite expects to find it.
      cluster = await describeCluster();
    }, 180_000);
  });

  describe('polling', () => {
    it('keeps the stored topology fresh', async () => {
      const plugin = new LocalPlugin({ writable: true });
      plugin.set('refreshIntervalMS', 300);
      const writes: unknown[] = [];
      const write = plugin.write.bind(plugin);
      plugin.write = vi.fn(async doc => {
        writes.push(doc);
        return write(doc);
      });

      const watcher = new Watcher({ uri: cluster.uri, plugin });
      watcher.start();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await watcher.stop();

      expect(writes.length).toBeGreaterThanOrEqual(2);
    }, 30_000);
  });

  describe('a standalone server', () => {
    // Started once here rather than per test, since container teardown is
    // slower than the default hook timeout.
    beforeAll(async () => {
      await startStandalone();
    }, 180_000);

    afterAll(async () => {
      await stopStandalone();
    }, 60_000);

    it('is rejected rather than watched', async () => {
      // A real standalone, since the mocked shape only proves the branch runs,
      // not that a live server triggers it.
      const watcher = new Watcher({
        uri: `mongodb://localhost:${STANDALONE_PORT}/`,
        plugin: new LocalPlugin({ writable: true }),
        driverOptions: { serverSelectionTimeoutMS: 5000 }
      });
      open.push(watcher);

      await expect(watcher.check()).rejects.toThrow(NotAReplicaSetError);
      expect(process.env[VAR]).toBeUndefined();
    }, 60_000);
  });
});
