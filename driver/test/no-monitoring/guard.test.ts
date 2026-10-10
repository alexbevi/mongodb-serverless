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

it('rejects unverified driver versions', async () => {
  const { assertVersion } = await import('../../src/no-monitoring/adapter.js');
  expect(() => assertVersion('7.7.1')).toThrow(/7.7.0/);
  expect(() => assertVersion('7.7.0')).not.toThrow();
});

it('rejects automatic encryption before the driver loads encryption dependencies', () => {
  const client = new MongoClient('mongodb://localhost:28017', { directConnection: true });
  Object.defineProperty(client.options, 'autoEncryption', { value: {} });
  expect(() => disableMonitoring(client)).toThrow(/encryption/);
});
