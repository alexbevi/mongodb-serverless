import { MongoClient, type MongoClientOptions, type CommandStartedEvent } from 'mongodb';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerlessMongoClient } from '../../src/client.js';
import { createCertificateUser, startSecureCluster } from '../../../test/harness/secure-cluster.js';
import { localLookup, stubSrvRecords } from '../../../test/harness/srv.js';
import { SerializedPlugin } from '../harness/serialized-plugin.js';

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
