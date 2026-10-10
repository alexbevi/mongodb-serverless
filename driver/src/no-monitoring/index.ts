import { verifyDriver } from './adapter.js';
import { MongoClient } from 'mongodb';
import { UnsupportedOperationError } from '../errors.js';

export function disableMonitoring<T extends MongoClient>(client: T): T {
  if (!client.options.directConnection) {
    throw new UnsupportedOperationError('disableMonitoring requires directConnection: true');
  }

  const mechanism = client.options.credentials?.mechanism;

  if (mechanism && !['DEFAULT', 'SCRAM-SHA-256', 'SCRAM-SHA-1'].includes(mechanism)) {
    throw new UnsupportedOperationError('disableMonitoring supports only SCRAM authentication');
  }

  verifyDriver();

  return client;
}
