import type { MongoClient } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Watcher } from '../src/watcher.js';
import { ServerlessPlugin } from '../../plugins/shared/src/index.js';
import type { ReplSetGetStatus } from '../../plugins/shared/src/index.js';

const status = {
  set: 'rs0',
  members: [{ name: 'a:27017', stateStr: 'PRIMARY', health: 1 }],
  ok: 1
};

const hello = { setName: 'rs0', hosts: ['a:27017'], me: 'a:27017', ok: 1 };

/** A real plugin, so refreshIntervalMS comes from the contract's config. */
class IntervalPlugin extends ServerlessPlugin {
  readonly name = 'interval';
  readonly version = '1.0.0';
  readonly author = 'test';
  readonly writes: ReplSetGetStatus[] = [];

  async setup(): Promise<void> {}
  async verify(): Promise<void> {}
  async read(): Promise<ReplSetGetStatus> {
    return status;
  }
  async write(doc: ReplSetGetStatus): Promise<void> {
    this.assertWritable();
    this.writes.push(doc);
  }
}

const setup = (intervalMS?: number) => {
  const plugin = new IntervalPlugin({ writable: true });

  if (intervalMS != null) plugin.set('refreshIntervalMS', intervalMS);

  const client = {
    connect: vi.fn(async function (this: MongoClient) {
      return this;
    }),
    db: vi.fn(() => ({
      command: vi.fn(async (doc: Record<string, unknown>) => ('hello' in doc ? hello : status))
    })),
    close: vi.fn(async () => {})
  };

  const watcher = new Watcher({
    uri: 'mongodb://a:27017/',
    plugin,
    createClient: vi.fn(() => client as never)
  });

  return { watcher, plugin, client };
};

/**
 * Lets queued promises settle between timer advances.
 *
 * A fixed number of microtask ticks would be a guess that breaks whenever a
 * cycle gains an await. Yielding to the macrotask queue drains whatever is
 * pending, and `advanceTimersToNextTimerAsync` keeps the fake clock still.
 */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('Watcher polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a cycle immediately on start', async () => {
    const { watcher, plugin } = setup(1000);
    watcher.start();
    await flush();

    expect(plugin.writes).toHaveLength(1);
    await watcher.stop();
  });

  it('runs again after refreshIntervalMS', async () => {
    const { watcher, plugin } = setup(1000);
    watcher.start();
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(plugin.writes).toHaveLength(2);
    await watcher.stop();
  });

  it('takes the interval from the plugin config', async () => {
    const { watcher, plugin } = setup(5000);
    watcher.start();
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(plugin.writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(plugin.writes).toHaveLength(2);

    await watcher.stop();
  });

  it('defaults to the contract default of 10 seconds', async () => {
    const { watcher, plugin } = setup();
    watcher.start();
    await flush();

    await vi.advanceTimersByTimeAsync(9_999);
    await flush();
    expect(plugin.writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(plugin.writes).toHaveLength(2);

    await watcher.stop();
  });

  it('stops running cycles after stop', async () => {
    const { watcher, plugin } = setup(1000);
    watcher.start();
    await flush();
    await watcher.stop();

    await vi.advanceTimersByTimeAsync(5000);
    await flush();

    expect(plugin.writes).toHaveLength(1);
  });

  it('closes the connection on stop', async () => {
    const { watcher, client } = setup(1000);
    watcher.start();
    await flush();
    await watcher.stop();

    expect(client.close).toHaveBeenCalled();
  });

  it('does not double up when started twice', async () => {
    const { watcher, plugin } = setup(1000);
    watcher.start();
    watcher.start();
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(plugin.writes).toHaveLength(2);
    await watcher.stop();
  });

  it('keeps polling after a failed cycle', async () => {
    // A cluster blip must not kill the loop; the next cycle should recover.
    const plugin = new IntervalPlugin({ writable: true });
    plugin.set('refreshIntervalMS', 1000);
    let calls = 0;

    const client = {
      connect: vi.fn(async function (this: MongoClient) {
        return this;
      }),
      db: vi.fn(() => ({
        command: vi.fn(async (doc: Record<string, unknown>) => {
          if ('hello' in doc) {
            calls += 1;

            if (calls === 1) throw new Error('transient blip');

            return hello;
          }

          return status;
        })
      })),
      close: vi.fn(async () => {})
    };

    const watcher = new Watcher({
      uri: 'mongodb://a:27017/',
      plugin,
      createClient: vi.fn(() => client as never)
    });

    watcher.start();
    await flush();
    expect(plugin.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(plugin.writes).toHaveLength(1);

    await watcher.stop();
  });

  it('reports a failed cycle through onError', async () => {
    const errors: unknown[] = [];
    const plugin = new IntervalPlugin({ writable: true });
    plugin.set('refreshIntervalMS', 1000);

    const client = {
      connect: vi.fn(async function (this: MongoClient) {
        return this;
      }),
      db: vi.fn(() => ({
        command: vi.fn(async () => {
          throw new Error('cluster gone');
        })
      })),
      close: vi.fn(async () => {})
    };

    const watcher = new Watcher({
      uri: 'mongodb://a:27017/',
      plugin,
      createClient: vi.fn(() => client as never),
      onError: error => void errors.push(error)
    });

    watcher.start();
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'cluster gone' });
    await watcher.stop();
  });

  it('stop is safe without start', async () => {
    const { watcher } = setup(1000);

    await expect(watcher.stop()).resolves.toBeUndefined();
  });
});
