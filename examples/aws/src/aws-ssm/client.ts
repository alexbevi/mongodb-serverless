import { MongoClient } from '@mongodb-serverless/driver';
import { SsmPlugin } from '@mongodb-serverless/plugin-aws-ssm';
import { requiredEnvironment } from '../environment.js';
import { initializePluginCollection } from '../initialization.js';
import { serverlessClientOptions } from '../serverless-options.js';

const database = process.env['DATABASE'] ?? 'mongodb_serverless_prod';

const collectionName = process.env['COLLECTION'] ?? 'serverless_patterns';

const plugin = new SsmPlugin({
  connectionStringParameter: requiredEnvironment('CONNECTION_STRING_PARAMETER'),
  topologyParameter: requiredEnvironment('TOPOLOGY_PARAMETER')
});

let client: MongoClient | undefined;

export const collection = await initializePluginCollection(
  async () => {
    await plugin.verify();

    return plugin.fetchDurationMs ?? 0;
  },
  commandStarted => {
    client ??= new MongoClient(undefined, {
      ...serverlessClientOptions(commandStarted), plugin
    });

    return client.db(database).collection(collectionName);
  },
  async () => {
    const retained = client;
    client = undefined;
    await retained?.close();
  }
);
