import { MongoClient } from '@mongodb-serverless/driver';
import { connectionStringFromSsm } from '../connection-string.js';
import { requiredEnvironment } from '../environment.js';
import { initializeParameterCollection } from '../initialization.js';
import { serverlessClientOptions } from '../serverless-options.js';

const database = process.env['DATABASE'] ?? 'mongodb_serverless_prod';

const collectionName = process.env['COLLECTION'] ?? 'serverless_patterns';

const connectionStringParameter = requiredEnvironment('CONNECTION_STRING_PARAMETER');

let client: MongoClient | undefined;

export const collection = await initializeParameterCollection(
  () => connectionStringFromSsm(connectionStringParameter),
  (connectionString, commandStarted) => {
    client ??= new MongoClient(connectionString, serverlessClientOptions(commandStarted));

    return client.db(database).collection(collectionName);
  },
  async () => {
    const retained = client;
    client = undefined;
    await retained?.close();
  }
);
