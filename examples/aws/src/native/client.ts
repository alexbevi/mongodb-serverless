import { MongoClient } from 'mongodb';
import { connectionStringFromSsm } from '../connection-string.js';
import { requiredEnvironment } from '../environment.js';
import { initializeParameterCollection } from '../initialization.js';

const database = process.env['DATABASE'] ?? 'bench';

const collectionName = process.env['COLLECTION'] ?? 'serverless_patterns';

const connectionStringParameter = requiredEnvironment('CONNECTION_STRING_PARAMETER');

let client: MongoClient | undefined;

export const collection = await initializeParameterCollection(
  () => connectionStringFromSsm(connectionStringParameter),
  (connectionString, commandStarted) => {
    client ??= new MongoClient(connectionString, { maxPoolSize: 1, minPoolSize: 0, monitorCommands: true });
    client.on('commandStarted', event => commandStarted(event.commandName));

    return client.db(database).collection(collectionName);
  }
);
