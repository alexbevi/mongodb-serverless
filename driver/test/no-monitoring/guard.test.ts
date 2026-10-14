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

it('accepts stable releases from the baseline through major version 7', async () => {
  const { assertVersion } = await import('../../src/no-monitoring/adapter.js');

  for (const version of ['7.7.0', '7.7.1', '7.8.0', '7.20.0', '7.7.0+build.1']) {
    expect(() => assertVersion(version)).not.toThrow();
  }

  for (const version of ['7.6.99', '6.20.0', '8.0.0', '7.8.0-beta.1', '7.7', 'garbage', '07.7.0', '7.7.0\n', '7.7.0+bad..build']) {
    expect(() => assertVersion(version)).toThrow(/>=7.7.0 <8.0.0/);
  }
});

it('rejects automatic encryption before the driver loads encryption dependencies', () => {
  const client = new MongoClient('mongodb://localhost:28017', { directConnection: true });
  Object.defineProperty(client.options, 'autoEncryption', { value: {} });
  expect(() => disableMonitoring(client)).toThrow(/encryption/);
});

it('installs hooks once when the patch module is loaded again', async () => {
  const { monitorModule } = await import('../../src/no-monitoring/adapter.js');
  disableMonitoring(new MongoClient('mongodb://localhost:28017', { directConnection: true }));
  const installed = monitorModule.Monitor.prototype.connect;
  const { activate } = await import('../../src/no-monitoring/patch.js?copy');
  activate(new MongoClient('mongodb://localhost:28017', { directConnection: true }));
  expect(monitorModule.Monitor.prototype.connect).toBe(installed);
});

it('rejects a client whose constructor is not from the patched driver instance', () => {
  const client = new MongoClient('mongodb://localhost:28017', { directConnection: true });
  Object.setPrototypeOf(client, null);
  expect(() => disableMonitoring(client)).toThrow(/same mongodb module/);
});

it('rejects an incompatible internal module before installing hooks', async () => {
  const { connectModule } = await import('../../src/no-monitoring/adapter.js');
  const original = Object.getOwnPropertyDescriptor(connectModule, 'makeSocket');

  if (!original) throw new Error('Missing makeSocket');

  try {
    Object.defineProperty(connectModule, 'makeSocket', { value: null, configurable: true });
    const client = new MongoClient('mongodb://localhost:28017', { directConnection: true });
    expect(() => disableMonitoring(client)).toThrow(/driver internals/);
  } finally {
    Object.defineProperty(connectModule, 'makeSocket', original);
  }
});
