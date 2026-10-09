import type { Document } from 'mongodb';
import type { ClusterClient } from '../src/cluster.js';
import { describe, expect, it, vi } from 'vitest';
import { ClusterConnection, type ClientFactory, type ClusterConnectionOptions } from '../src/cluster.js';
import {
  AuthenticationFailedError,
  ClusterUnreachableError,
  NotAReplicaSetError
} from '../src/errors.js';

const helloReplicaSet = {
  setName: 'rs0',
  hosts: ['a:27017', 'b:27017'],
  me: 'a:27017',
  isWritablePrimary: true,
  ok: 1
};

/** A fake client whose `command` behaviour each test chooses. */
const fakeClient = (command: (doc: Document) => Promise<Document>) => {
  const closed = { count: 0 };

  const client = {
    connect: vi.fn(async function (this: ClusterClient) {
      return this;
    }),
    db: vi.fn(() => ({ command: vi.fn(command) })),
    close: vi.fn(async () => {
      closed.count += 1;
    })
  };

  return { client, closed };
};

const connectionFor = (
  command: (doc: Document) => Promise<Document>,
  options: Partial<ClusterConnectionOptions> = {}
) => {
  const fake = fakeClient(command);

  const connection = new ClusterConnection({
    uri: 'mongodb://host:27017/?replicaSet=rs0',
    createClient: vi.fn(() => fake.client),
    ...options
  });

  return { ...fake, connection };
};

/** Mirrors a real MongoServerError closely enough to be classified. */
const serverError = (code: number, message: string): Error => {
  const error = new Error(message);
  Object.assign(error, { code, name: 'MongoServerError' });

  return error;
};

const selectionError = (message: string): Error => {
  const error = new Error(message);
  Object.assign(error, { name: 'MongoServerSelectionError' });

  return error;
};

describe('ClusterConnection.hello', () => {
  it('returns the replica set name and members', async () => {
    const { connection } = connectionFor(async () => helloReplicaSet);

    await expect(connection.hello()).resolves.toEqual({
      setName: 'rs0',
      hosts: ['a:27017', 'b:27017'],
      me: 'a:27017'
    });
  });

  it('does not expose non-string hosts from a malformed hello response', async () => {
    const { connection } = connectionFor(async () => ({
      ...helloReplicaSet, hosts: ['a:27017', 42]
    }));

    await expect(connection.hello()).resolves.toMatchObject({ hosts: [] });
  });

  it('sends the hello command', async () => {
    const seen: Document[] = [];

    const { connection } = connectionFor(async doc => {
      seen.push(doc);

      return helloReplicaSet;
    });

    await connection.hello();

    expect(seen).toEqual([{ hello: 1 }]);
  });

  it('sets no pool options', async () => {
    // minPoolSize turns an auth failure into an opaque PoolClearedError, with
    // the real cause buried on .cause.
    const create = vi.fn<ClientFactory>(() => fakeClient(async () => helloReplicaSet).client);

    const connection = new ClusterConnection({
      uri: 'mongodb://host:27017/',
      createClient: create
    });

    await connection.hello();

    const options = create.mock.calls[0]?.[1] ?? {};
    expect(options).not.toHaveProperty('minPoolSize');
    expect(options).not.toHaveProperty('maxPoolSize');
  });

  it('connects once across two calls', async () => {
    const { connection, client } = connectionFor(async () => helloReplicaSet);
    await connection.hello();
    await connection.hello();

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('throws NotAReplicaSetError when setName is absent', async () => {
    // A standalone reports neither setName nor hosts.
    const { connection } = connectionFor(async () => ({ isWritablePrimary: true, ok: 1 }));

    await expect(connection.hello()).rejects.toThrow(NotAReplicaSetError);
  });

  it('says what it found instead of a replica set', async () => {
    const { connection } = connectionFor(async () => ({ isWritablePrimary: true, ok: 1 }));

    await expect(connection.hello()).rejects.toThrow(/replica set/i);
  });

  it('throws NotAReplicaSetError for a sharded cluster', async () => {
    const { connection } = connectionFor(async () => ({ msg: 'isdbgrid', ok: 1 }));

    await expect(connection.hello()).rejects.toThrow(/mongos|sharded/i);
  });

  it('throws AuthenticationFailedError on code 18', async () => {
    const { connection } = connectionFor(async () => {
      throw serverError(18, 'Authentication failed.');
    });

    await expect(connection.hello()).rejects.toThrow(AuthenticationFailedError);
  });

  it('names the uri host in the auth error, without the password', async () => {
    const fake = fakeClient(async () => {
      throw serverError(18, 'Authentication failed.');
    });

    const connection = new ClusterConnection({
      uri: 'mongodb://user:secret@host:27017/',
      createClient: vi.fn(() => fake.client)
    });

    const attempt = connection.hello();
    await expect(attempt).rejects.toThrow(/host:27017/);
    await expect(attempt).rejects.not.toThrow(/secret/);
  });

  it('throws ClusterUnreachableError on server selection failure', async () => {
    const { connection } = connectionFor(async () => {
      throw selectionError('connect ECONNREFUSED 127.0.0.1:27017');
    });

    await expect(connection.hello()).rejects.toThrow(ClusterUnreachableError);
  });

  it('keeps the underlying reason on the cause', async () => {
    const cause = selectionError('getaddrinfo ENOTFOUND nope.invalid');

    const { connection } = connectionFor(async () => {
      throw cause;
    });

    await expect(connection.hello()).rejects.toMatchObject({ cause });
  });

  it('reports a failure from connect, not just from the command', async () => {
    const fake = fakeClient(async () => helloReplicaSet);
    fake.client.connect = vi.fn(async () => {
      throw selectionError('connect ECONNREFUSED 127.0.0.1:27017');
    });

    const connection = new ClusterConnection({
      uri: 'mongodb://host:27017/',
      createClient: vi.fn(() => fake.client)
    });

    await expect(connection.hello()).rejects.toThrow(ClusterUnreachableError);
  });

  it('passes an unrecognised error through unchanged', async () => {
    const cause = new Error('something else entirely');

    const { connection } = connectionFor(async () => {
      throw cause;
    });

    await expect(connection.hello()).rejects.toBe(cause);
  });
});

describe('ClusterConnection.close', () => {
  it('closes the client it opened', async () => {
    const { connection, closed } = connectionFor(async () => helloReplicaSet);
    await connection.hello();
    await connection.close();

    expect(closed.count).toBe(1);
  });

  it('closes nothing when never connected', async () => {
    const { connection, closed } = connectionFor(async () => helloReplicaSet);
    await connection.close();

    expect(closed.count).toBe(0);
  });

  it('is idempotent', async () => {
    const { connection, closed } = connectionFor(async () => helloReplicaSet);
    await connection.hello();
    await connection.close();
    await connection.close();

    expect(closed.count).toBe(1);
  });
});
