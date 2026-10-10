import { MongoClient } from 'mongodb';
import { UnsupportedOperationError } from '../errors.js';

export function disableMonitoring<T extends MongoClient>(client: T): T {
  if (!client.options.directConnection) {
    throw new UnsupportedOperationError('disableMonitoring requires directConnection: true');
  }

  return client;
}
