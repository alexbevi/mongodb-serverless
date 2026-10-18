import { reportRole } from '../harness/handshake.js';
import { createRequire } from 'node:module';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientPair } from '../../src/clients.js';
import { stubSrvRecords } from '../../../test/harness/srv.js';
import { SerializedPlugin } from '../harness/serialized-plugin.js';

const require = createRequire(import.meta.url);

// Use the pinned driver's TXT rules; only the network and identity providers are mocked.
const { resolveSRVRecord }: { resolveSRVRecord(options: MongoClient['options']): Promise<MongoClient['options']['hosts']> } =
  require('mongodb/lib/connection_string.js');

const status = {
  set: 'securetest',
  members: [
    { name: 'primary.cluster.localhost:27017', stateStr: 'PRIMARY', health: 1 },
    { name: 'secondary.cluster.localhost:27017', stateStr: 'SECONDARY', health: 1 }
  ]
};

const oidcCallback = vi.fn(async () => ({ accessToken: 'private-oidc-token', expiresInSeconds: 3600 }));

const awsProvider = vi.fn(async () => ({ accessKeyId: 'private-access-key', secretAccessKey: 'private-secret-key', sessionToken: 'private-session-token' }));

interface AuthCase {
  label: string;
  userInfo?: string;
  query?: string;
  options?: MongoClientOptions;
  source?: string;
}

const cases: AuthCase[] = [
  { label: 'no authentication' },
  { label: 'DEFAULT', userInfo: 'test:private-password@', source: 'admin' },
  { label: 'SCRAM-SHA-1', userInfo: 'test:private-password@', options: { authMechanism: 'SCRAM-SHA-1' }, source: 'admin' },
  {
    label: 'SCRAM-SHA-256',
    options: { auth: { username: 'test', password: 'private-password' }, authMechanism: 'SCRAM-SHA-256' },
    source: 'admin'
  },
  {
    label: 'X.509 certificate subject',
    options: { authMechanism: 'MONGODB-X509', tlsCertificateKeyFile: '/private/client.pem' },
    source: '$external'
  },
  {
    label: 'X.509 explicit username',
    userInfo: 'CN%3Dtest@',
    query: 'authMechanism=MONGODB-X509',
    options: { tlsCertificateKeyFile: '/private/client.pem' },
    source: '$external'
  },
  {
    label: 'GSSAPI principal and service properties',
    userInfo: 'user%40EXAMPLE.COM@',
    options: { authMechanism: 'GSSAPI', authMechanismProperties: { SERVICE_NAME: 'mongodb', SERVICE_REALM: 'EXAMPLE.COM', CANONICALIZE_HOST_NAME: 'forward' } },
    source: '$external'
  },
  {
    label: 'PLAIN with explicit external source',
    userInfo: 'test:private-password@',
    query: 'authMechanism=PLAIN&authSource=%24external',
    source: '$external'
  },
  {
    label: 'PLAIN with native TXT source',
    userInfo: 'test:private-password@',
    options: { authMechanism: 'PLAIN' },
    source: 'admin'
  },
  {
    label: 'AWS credential provider',
    options: { authMechanism: 'MONGODB-AWS', authMechanismProperties: { AWS_CREDENTIAL_PROVIDER: awsProvider } },
    source: '$external'
  },
  { label: 'AWS ambient credentials', query: 'authMechanism=MONGODB-AWS', source: '$external' },
  {
    label: 'OIDC machine callback',
    options: { authMechanism: 'MONGODB-OIDC', authMechanismProperties: { OIDC_CALLBACK: oidcCallback } },
    source: '$external'
  },
  {
    label: 'OIDC human callback and allowed hosts',
    userInfo: 'test@',
    options: { authMechanism: 'MONGODB-OIDC', authMechanismProperties: { OIDC_HUMAN_CALLBACK: oidcCallback, ALLOWED_HOSTS: ['*.cluster.localhost'] } },
    source: '$external'
  },
  {
    label: 'OIDC Azure environment',
    options: { authMechanism: 'MONGODB-OIDC', authMechanismProperties: { ENVIRONMENT: 'azure', TOKEN_RESOURCE: 'resource' } },
    source: '$external'
  },
  {
    label: 'OIDC GCP environment',
    options: { authMechanism: 'MONGODB-OIDC', authMechanismProperties: { ENVIRONMENT: 'gcp', TOKEN_RESOURCE: 'resource' } },
    source: '$external'
  },
  {
    label: 'OIDC Kubernetes environment',
    options: { authMechanism: 'MONGODB-OIDC', authMechanismProperties: { ENVIRONMENT: 'k8s' } },
    source: '$external'
  }
];

function mockConnections() {
  const built: MongoClient[] = [];
  const commands: string[] = [];

  const createClient = vi.fn((uri: string, options?: MongoClientOptions) => {
    const native = new MongoClient(uri, options);
    const admin = native.db('admin');
    built.push(native);

    vi.spyOn(native, 'connect').mockImplementation(async () => {
      if (native.options.srvHost) await resolveSRVRecord(native.options);

      reportRole(native, uri.includes('secondary.') ? 'RSSecondary' : 'RSPrimary');

      return native;
    });
    vi.spyOn(native, 'close').mockResolvedValue();
    vi.spyOn(native, 'db').mockReturnValue(admin);
    vi.spyOn(admin, 'command').mockImplementation(async command => {
      commands.push(Object.keys(command)[0]!);

      if (command['hello']) return { setName: status.set, me: status.members[0]!.name };

      if (command['replSetGetStatus']) return status;

      throw new Error('Unexpected discovery command');
    });

    return native;
  });

  return { built, commands, createClient };
}

afterEach(() => vi.restoreAllMocks());

describe('authentication settings with mocked connections', () => {
  it.each(cases)('preserves $label through discovery, cached reads/writes, and refresh', async scenario => {
    const dns = stubSrvRecords(27017);
    const plugin = new SerializedPlugin();
    const { built, commands, createClient } = mockConnections();
    const uri = `mongodb+srv://${scenario.userInfo ?? ''}cluster.localhost/app?${scenario.query ?? ''}`;

    for (let run = 0; run < 2; run += 1) {
      const pair = new ClientPair({ uri, plugin, createClient, driverOptions: scenario.options ?? {} });

      try {
        const write = await pair.write();
        const read = await pair.read();
        const discovered = built[0]!;

        expect(discovered.options.credentials?.source).toBe(scenario.source);
        expect(read).not.toBe(write);

        for (const direct of [read, write]) {
          expect(direct.connect).toHaveBeenCalledOnce();
          expect(direct.options.directConnection).toBe(true);
          expect(direct.options.credentials).toEqual(discovered.options.credentials);
          expect(direct.options.tlsCertificateKeyFile).toBe(discovered.options.tlsCertificateKeyFile);

          for (const [key, value] of Object.entries(scenario.options?.authMechanismProperties ?? {})) {
            expect(direct.options.credentials?.mechanismProperties[key]).toBe(value);
          }
        }

        if (run === 1) {
          await pair.refreshTopology(pair.generation);
          expect(built.at(-1)?.options.credentials).toEqual(discovered.options.credentials);
          expect(built.at(-1)?.options.directConnection).toBe(true);
        }
      } finally {
        await pair.close();
      }
    }

    const credentials = built[0]!.options.credentials;
    const authentication = (await plugin.read())?.authentication;

    expect(authentication).toEqual(credentials ? { mechanism: credentials.mechanism, source: credentials.source } : undefined);
    expect(plugin.document).not.toMatch(/private-|password|username|Certificate|TOKEN|CALLBACK|PROVIDER/);
    expect(commands.filter(command => command === 'replSetGetStatus')).toHaveLength(2);
    expect(dns).toHaveBeenCalledTimes(2);
    expect(built).toHaveLength(5);
  });

  it.each([
    { query: 'authSource=uri-db', options: {}, source: 'uri-db' },
    { query: 'AUTHSOURCE=uri-db', options: {}, source: 'uri-db' },
    { query: 'authSource=uri-db', options: { authSource: 'option-db' }, source: 'option-db' },
    { query: '', options: { authSource: 'option-db' }, source: 'option-db' }
  ])('honors explicit authSource over cached defaults: $source', async ({ query, options, source }) => {
    const plugin = new SerializedPlugin();
    await plugin.write({ ...status, authentication: { mechanism: 'DEFAULT', source: 'cached-db' } });
    const { createClient } = mockConnections();
    const pair = new ClientPair({ uri: `mongodb+srv://test:private-password@cluster.localhost/app?${query}`, plugin, createClient, driverOptions: options });

    try {
      expect((await pair.write()).options.credentials?.source).toBe(source);
      expect((await pair.read()).options.credentials?.source).toBe(source);
    } finally {
      await pair.close();
    }
  });

  it.each([false, true])('retains native rejection of AWS URI credentials (cached=%s)', async cached => {
    const uri = 'mongodb+srv://key:secret@cluster.localhost/?authMechanism=MONGODB-AWS';
    const plugin = new SerializedPlugin();

    if (cached) await plugin.write({ ...status, authentication: { mechanism: 'MONGODB-AWS', source: '$external' } });

    const { createClient } = mockConnections();
    const pair = new ClientPair({ uri, plugin, createClient });

    try {
      expect(() => new MongoClient(uri)).toThrow(/username and password cannot be provided/);
      await expect(pair.write()).rejects.toThrow(/username and password cannot be provided/);
    } finally {
      await pair.close();
    }
  });

  it('takes rotated passwords and callbacks from each new wrapper', async () => {
    stubSrvRecords(27017);

    for (const mechanism of ['DEFAULT', 'MONGODB-OIDC'] as const) {
      const plugin = new SerializedPlugin();
      const { createClient } = mockConnections();

      for (const secret of ['first-private-value', 'rotated-private-value']) {
        const callback = async () => ({ accessToken: secret });

        const driverOptions: MongoClientOptions = mechanism === 'DEFAULT'
          ? { auth: { username: 'test', password: secret } }
          : { authMechanism: mechanism, authMechanismProperties: { OIDC_CALLBACK: callback } };

        const pair = new ClientPair({ uri: 'mongodb+srv://cluster.localhost/app', plugin, createClient, driverOptions });

        try {
          for (const direct of [await pair.write(), await pair.read()]) {
            const credentials = direct.options.credentials!;

            if (mechanism === 'DEFAULT') expect(credentials.password).toBe(secret);
            else expect(credentials.mechanismProperties.OIDC_CALLBACK).toBe(callback);
          }

          expect(plugin.document).not.toContain(secret);
        } finally {
          await pair.close();
        }
      }
    }
  });

  it('rediscovers native defaults when the cached authentication mechanism changes', async () => {
    const dns = stubSrvRecords(27017);
    const plugin = new SerializedPlugin();
    await plugin.write({ ...status, authentication: { mechanism: 'MONGODB-X509', source: '$external' } });
    const { createClient } = mockConnections();
    const pair = new ClientPair({ uri: 'mongodb+srv://test:private-password@cluster.localhost/app', plugin, createClient });

    try {
      expect((await pair.write()).options.credentials?.source).toBe('admin');
      expect((await plugin.read())?.authentication).toEqual({ mechanism: 'DEFAULT', source: 'admin' });
      expect(dns).toHaveBeenCalledTimes(2);
    } finally {
      await pair.close();
    }
  });
});
