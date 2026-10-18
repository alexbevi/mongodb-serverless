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
  seeds = new ConnectionString(uri).hosts
): Promise<ReplSetGetStatus> {
  const expectedSet = options?.replicaSet ?? new ConnectionString(uri).searchParams.get('replicaSet');
  let failure: unknown;

  for (const seed of seeds) {
    const client = createClient(directUri(uri, seed), { serverSelectionTimeoutMS: 5000, ...options, directConnection: true, retryWrites: false });

    try {
      await client.connect();
      const hello = await client.db('admin').command({ hello: 1 });

      if (!hello['setName'] || hello['msg'] === 'isdbgrid') {
        throw new ServerlessDriverError('Discovery requires a replica set; standalone and sharded clusters are unsupported.');
      }

      if (expectedSet != null && hello['setName'] !== expectedSet) {
        throw new ServerlessDriverError(
          `Expected replica set "${expectedSet}", but "${seed}" reported "${hello['setName']}".`
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
