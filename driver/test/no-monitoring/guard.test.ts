import { MongoClient } from 'mongodb';
import { expect, it } from 'vitest';
import { disableMonitoring } from '../../src/no-monitoring/index.js';

it('requires a direct connection before installing the patch', () => {
  const client = new MongoClient('mongodb://localhost:28017');
  expect(() => disableMonitoring(client)).toThrow(/directConnection/);
});

it('rejects unsupported authentication before connecting', () => {
  const client = new MongoClient('mongodb://localhost:28017', {
    directConnection: true,
    authMechanism: 'MONGODB-X509'
  });

  expect(() => disableMonitoring(client)).toThrow(/SCRAM/);
});
