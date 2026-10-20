import { MongoClient, type MongoClientOptions, type CommandStartedEvent } from 'mongodb';
import { afterEach, expect, it, vi } from 'vitest';
import * as connectionStrings from 'mongodb-connection-string-url';
import { ClientPair } from '../../src/clients.js';
import { ServerlessMongoClient } from '../../src/client.js';
import { createCertificateUser, startSecureCluster } from '../../../test/harness/secure-cluster.js';
import { localLookup, stubSrvRecords } from '../../../test/harness/srv.js';
import { SerializedPlugin } from '../harness/serialized-plugin.js';

vi.mock('mongodb-connection-string-url', async importOriginal => {
  const actual = await importOriginal<typeof import('mongodb-connection-string-url')>();

  return { ...actual, ConnectionString: vi.fn(function (...args: ConstructorParameters<typeof actual.ConnectionString>) {
    return new actual.ConnectionString(...args);
  }) };
});

afterEach(() => vi.restoreAllMocks());

it.each(['DEFAULT', 'SCRAM-SHA-1', 'SCRAM-SHA-256', 'MONGODB-X509'] as const)(
  'carries %s authentication through discovery and cached direct connections', async mechanism => {
    const fixture = await startSecureCluster();
    const identity = mechanism === 'MONGODB-X509' ? await createCertificateUser() : undefined;

    const options: MongoClientOptions = identity
      ? { authMechanism: mechanism, tlsCAFile: fixture.ca, tlsCertificateKeyFile: identity.certificate, servername: 'localhost' }
      : { authMechanism: mechanism, tlsCAFile: fixture.ca, servername: 'localhost' };

    const uri = identity
      ? 'mongodb+srv://cluster.localhost/app'
      : 'mongodb+srv://test:fixture-password@cluster.localhost/app';

    const source = identity ? '$external' : 'admin';
    const dns = stubSrvRecords(29400);
    const plugin = new SerializedPlugin();
    const built: MongoClient[] = [];
    const commands: CommandStartedEvent[] = [];

    try {
      for (let run = 0; run < 2; run += 1) {
        const client = new ServerlessMongoClient(
          uri,
          {
            ...options, plugin, lookup: localLookup, monitorCommands: true, serverSelectionTimeoutMS: 2000,
            createClient(uri, options) {
              const native = new MongoClient(uri, options);
              native.on('commandStarted', event => commands.push(event));
              built.push(native);

              return native;
            }
          }
        );

        try {
          await expect(client.db('auth_carry').collection('checks').insertOne({ run })).resolves.toMatchObject({ acknowledged: true });
          await expect(client.db('auth_carry').collection('checks').findOne({ run })).resolves.toMatchObject({ run });

          for (const native of built.filter(candidate => candidate.options.directConnection)) {
            expect(native.options.credentials?.source).toBe(source);
          }
        } finally {
          await client.close();
        }
      }

      expect(built[0]?.options.credentials?.source).toBe(source);
      expect((await plugin.read())?.authentication).toEqual({ mechanism, source });
      expect(plugin.document).not.toContain('fixture-password');
      expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
      expect(dns).toHaveBeenCalledTimes(2);
    } finally {
      await identity?.cleanup();
    }
  }, 120_000
);

it('parses cached authentication settings once per client pair', async () => {
  const fixture = await startSecureCluster();
  const native = new MongoClient(fixture.uri);
  const plugin = new SerializedPlugin();

  try {
    const status = await native.db('admin').command({ replSetGetStatus: 1 });
    await plugin.write({ ...status, authentication: { mechanism: 'DEFAULT', source: 'admin' } });
  } finally {
    await native.close();
  }

  const parse = vi.mocked(connectionStrings.ConnectionString).mockClear();

  const pair = new ClientPair({
    uri: 'mongodb+srv://test:fixture-password@cluster.localhost/app', plugin,
    driverOptions: { tlsCAFile: fixture.ca, servername: 'localhost', lookup: localLookup },
    createClient: (uri, options) => new MongoClient(uri, options)
  });

  try {
    const writer = await pair.write();
    await writer.db('auth_carry').collection('checks').insertOne({ parsedOnce: true });
    const reader = await pair.read();
    await expect(reader.db('auth_carry').collection('checks').findOne({ parsedOnce: true })).resolves.toBeTruthy();
    expect(writer.options.credentials?.source).toBe('admin');
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    await pair.close();
  }
});
