import { describe, expect, it, vi } from 'vitest';
import { ClusterConnection } from '../src/cluster.js';
import { NotAReplicaSetError } from '../src/errors.js';

const healthy = {
  set: 'rs0',
  date: new Date('2026-01-01T00:00:00Z'),
  myState: 1,
  members: [
    { _id: 0, name: 'a:27017', stateStr: 'PRIMARY', health: 1, uptime: 100 },
    { _id: 1, name: 'b:27017', stateStr: 'SECONDARY', health: 1, uptime: 99 }
  ],
  ok: 1
};

const connectionFor = (command: (doc: Record<string, unknown>) => Promise<unknown>) => {
  const client = {
    connect: vi.fn(async function (this: unknown) {
      return this;
    }),
    db: vi.fn(() => ({ command: vi.fn(command) })),
    close: vi.fn(async () => {})
  };

  return new ClusterConnection({
    uri: 'mongodb://host:27017/',
    createClient: vi.fn(() => client as never)
  });
};

const serverError = (code: number, message: string): Error => {
  const error = new Error(message);
  Object.assign(error, { code, name: 'MongoServerError' });

  return error;
};

describe('ClusterConnection.status', () => {
  it('sends the replSetGetStatus command', async () => {
    const seen: Record<string, unknown>[] = [];

    const connection = connectionFor(async doc => {
      seen.push(doc);

      return healthy;
    });

    await connection.status();

    expect(seen).toEqual([{ replSetGetStatus: 1 }]);
  });

  it('returns the document unchanged', async () => {
    // The watcher stores what the cluster said; it does not reduce it, since
    // the driver reads fields the watcher has no reason to know about.
    const connection = connectionFor(async () => healthy);

    await expect(connection.status()).resolves.toEqual(healthy);
  });

  it('keeps every member', async () => {
    const connection = connectionFor(async () => healthy);
    const status = await connection.status();

    expect(status).toMatchObject({
      members: [{ name: 'a:27017' }, { name: 'b:27017' }]
    });
  });

  it('returns a document with no primary rather than rejecting it', async () => {
    // Mid-election every member reports SECONDARY. That is a real state of a
    // healthy cluster, so the watcher records it and lets the driver decide.
    const electing = {
      set: 'rs0',
      members: [
        { name: 'a:27017', stateStr: 'SECONDARY', health: 1 },
        { name: 'b:27017', stateStr: 'SECONDARY', health: 1 }
      ],
      ok: 1
    };

    const connection = connectionFor(async () => electing);

    await expect(connection.status()).resolves.toEqual(electing);
  });

  it('returns a document whose members are all unhealthy', async () => {
    const degraded = {
      set: 'rs0',
      members: [{ name: 'a:27017', stateStr: '(not reachable/healthy)', health: 0 }],
      ok: 1
    };

    const connection = connectionFor(async () => degraded);

    await expect(connection.status()).resolves.toEqual(degraded);
  });

  it('throws NotAReplicaSetError on code 76', async () => {
    const connection = connectionFor(async () => {
      throw serverError(76, 'not running with --replSet');
    });

    await expect(connection.status()).rejects.toThrow(NotAReplicaSetError);
  });

  it('mentions --replSet so the operator knows what to fix', async () => {
    const connection = connectionFor(async () => {
      throw serverError(76, 'not running with --replSet');
    });

    await expect(connection.status()).rejects.toThrow(/--replSet/);
  });

  it('reuses the connection hello opened', async () => {
    const client = {
      connect: vi.fn(async function (this: unknown) {
        return this;
      }),
      db: vi.fn(() => ({
        command: vi.fn(async (doc: Record<string, unknown>) =>
          'hello' in doc ? { setName: 'rs0', hosts: [], me: 'a:27017', ok: 1 } : healthy
        )
      })),
      close: vi.fn(async () => {})
    };

    const connection = new ClusterConnection({
      uri: 'mongodb://host:27017/',
      createClient: vi.fn(() => client as never)
    });

    await connection.hello();
    await connection.status();

    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});
