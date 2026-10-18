import { ConnectionString } from 'mongodb-connection-string-url';
import { assertStatus } from '../../plugins/shared/src/index.js';
import type { ReplSetGetStatus } from './plugin.js';
import type { ClientFactory } from './clients.js';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import { ServerlessDriverError } from './errors.js';
import { parseTopology } from './topology.js';
import { directUri } from './uri.js';

export interface DiscoveryConnection {
  status: ReplSetGetStatus;
  client: MongoClient;
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

export async function openDiscovery(
  uri: string,
  createClient: ClientFactory,
  options?: MongoClientOptions,
  seeds?: string[],
  disableMonitoring = false
): Promise<DiscoveryConnection> {
  const original = new ConnectionString(uri);
  const expectedSet = options?.replicaSet ?? original.searchParams.get('replicaSet');
  const direct = seeds ?? (original.isSRV ? undefined : original.hosts);
  const candidates = direct?.map(seed => directUri(uri, seed)) ?? [uri];
  const settings = { serverSelectionTimeoutMS: 5000, ...options, retryWrites: false };
  let failure: unknown;

  if (direct) settings.directConnection = true;

  for (const candidate of candidates) {
    const client = createClient(candidate, settings);

    try {
      if (direct && disableMonitoring) {
        const patch = await import('./no-monitoring/index.js');
        patch.disableMonitoring(client);
      }

      await client.connect();
      const hello = await client.db('admin').command({ hello: 1 });

      if (!hello['setName'] || hello['msg'] === 'isdbgrid') {
        throw new ServerlessDriverError('Discovery requires a replica set; standalone and sharded clusters are unsupported.');
      }

      if (expectedSet != null && hello['setName'] !== expectedSet) {
        throw new ServerlessDriverError(
          `Expected replica set "${expectedSet}", but "${new ConnectionString(candidate).hosts.join(', ')}" reported "${hello['setName']}".`
        );
      }

      const status = await client.db('admin').command({ replSetGetStatus: 1 });
      assertStatus(status);
      parseTopology(status);

      const credentials = client.options.credentials;

      const resolved = credentials
        ? { ...status, authentication: { mechanism: credentials.mechanism, source: credentials.source } }
        : status;

      const host = isString(hello['me']) ? hello['me'] : new ConnectionString(candidate).hosts[0];

      return { status: resolved, client, host };
    } catch (error) {
      failure = error;
      await client.close().catch(() => {});
    }
  }

  throw failure ?? new ServerlessDriverError('No discovery seeds are available.');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
