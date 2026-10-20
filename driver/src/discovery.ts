import { ConnectionString } from 'mongodb-connection-string-url';
import { assertStatus } from '../../plugins/shared/src/index.js';
import type { ReplSetGetStatus } from './plugin.js';
import type { ClientFactory } from './clients.js';
import type { MongoClientOptions } from 'mongodb';
import { ServerlessDriverError } from './errors.js';
import { parseTopology } from './topology.js';
import { directUri } from './uri.js';
import { resolveSeeds } from './seeds.js';
import { observeMember, type MemberConnection } from './member.js';

export interface DiscoveryConnection extends MemberConnection {
  status: ReplSetGetStatus;
  host: string | undefined;
}

export async function discoverTopology(
  uri: string,
  createClient: ClientFactory,
  options?: MongoClientOptions,
  seeds?: string[],
  disableMonitoring = false
): Promise<ReplSetGetStatus> {
  const discovered = await openDiscovery(uri, createClient, options, seeds, disableMonitoring);

  try {
    return discovered.status;
  } finally {
    await discovered.client.close();
  }
}

export function openDiscovery(
  uri: string,
  createClient: ClientFactory,
  options?: MongoClientOptions,
  seeds?: string[],
  disableMonitoring = false
): Promise<DiscoveryConnection> {
  return trySeeds(uri, createClient, options, seeds, disableMonitoring, async member =>
    Object.assign(member, { status: await readTopology(member) })
  );
}

export function openSeed(
  uri: string,
  createClient: ClientFactory,
  options?: MongoClientOptions,
  disableMonitoring = false
): Promise<MemberConnection> {
  return trySeeds(uri, createClient, options, undefined, disableMonitoring, async member => member);
}

export async function readTopology(member: MemberConnection): Promise<ReplSetGetStatus> {
  const status = await member.client.db('admin').command({ replSetGetStatus: 1 });
  assertStatus(status);
  parseTopology(status);
  const credentials = member.client.options.credentials;

  return credentials
    ? { ...status, authentication: { mechanism: credentials.mechanism, source: credentials.source } }
    : status;
}

async function trySeeds<T>(
  uri: string,
  createClient: ClientFactory,
  options: MongoClientOptions | undefined,
  seeds: string[] | undefined,
  disableMonitoring: boolean,
  accept: (member: MemberConnection) => Promise<T>
): Promise<T> {
  const resolved = seeds ? { hosts: seeds, options } : await resolveSeeds(uri, options);
  const expectedSet = resolved.options?.replicaSet ?? new ConnectionString(uri).searchParams.get('replicaSet');

  const settings = {
    serverSelectionTimeoutMS: 5000, ...resolved.options, retryWrites: false, directConnection: true
  };

  let failure: unknown;

  for (const seed of resolved.hosts) {
    const candidate = directUri(uri, seed, resolved.options);
    const client = createClient(candidate, settings);

    try {
      const member = observeMember(client);

      if (disableMonitoring) {
        const patch = await import('./no-monitoring/index.js');
        patch.disableMonitoring(client);
      }

      await client.connect();

      if (!member.setName || member.type === 'Mongos') {
        throw new ServerlessDriverError('Discovery requires a replica set; standalone and sharded clusters are unsupported.');
      }

      if (expectedSet != null && member.setName !== expectedSet) {
        throw new ServerlessDriverError(
          `Expected replica set "${expectedSet}", but "${new ConnectionString(candidate).hosts.join(', ')}" reported "${member.setName}".`
        );
      }

      member.host ??= new ConnectionString(candidate).hosts[0];

      return await accept(member);
    } catch (error) {
      failure = error;
      await client.close().catch(() => {});
    }
  }

  throw failure ?? new ServerlessDriverError('No discovery seeds are available.');
}
