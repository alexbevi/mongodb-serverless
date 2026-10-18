import { ConnectionString } from 'mongodb-connection-string-url';
import { assertStatus } from '../../plugins/shared/src/index.js';
import type { ReplSetGetStatus } from './plugin.js';
import type { ClientFactory } from './clients.js';
import type { MongoClientOptions } from 'mongodb';
import { ServerlessDriverError } from './errors.js';
import { parseTopology } from './topology.js';
import { directUri } from './uri.js';

export async function discoverTopology(
  uri: string,
  createClient: ClientFactory,
  options?: MongoClientOptions,
  seeds?: string[]
): Promise<ReplSetGetStatus> {
  const expectedSet = options?.replicaSet ?? new ConnectionString(uri).searchParams.get('replicaSet');
  const candidates = seeds?.map(seed => directUri(uri, seed)) ?? [uri];
  const settings = { serverSelectionTimeoutMS: 5000, ...options, retryWrites: false };
  let failure: unknown;

  if (seeds) settings.directConnection = true;

  for (const candidate of candidates) {
    const client = createClient(candidate, settings);

    try {
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

      return status;
    } catch (error) {
      failure = error;
    } finally {
      await client.close();
    }
  }

  throw failure ?? new ServerlessDriverError('No discovery seeds are available.');
}
