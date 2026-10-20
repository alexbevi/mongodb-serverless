import dns from 'node:dns';
import { afterEach, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { ServerlessMongoClient } from '../src/client.js';
import { resolveSeeds } from '../src/seeds.js';
import { stubSrvRecords } from '../../test/harness/srv.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  { label: 'a foreign SRV domain', host: 'attacker.example.net', txt: [['authSource=admin']], error: /hostname with parent/i },
  { label: 'multiple TXT records', host: 'member.cluster.localhost', txt: [['authSource=admin'], ['replicaSet=rs0']], error: /Multiple text/ },
  { label: 'unsupported TXT options', host: 'member.cluster.localhost', txt: [['tls=false']], error: /Text record may only/ },
  { label: 'empty TXT source', host: 'member.cluster.localhost', txt: [['authSource=']], error: /empty URI params/ },
  { label: 'load-balanced TXT mode', host: 'member.cluster.localhost', txt: [['loadBalanced=true']], error: /Load-balanced/ }
])('rejects $label before opening a connection', async ({ host, txt, error }) => {
  // SAFETY: Only the SRV/TXT overloads used by MongoDB's resolver are exercised.
  const resolve = (async (_hostname: string, type: string) => type === 'SRV'
    ? [{ name: host, port: 27017, weight: 0, priority: 0 }] : txt) as typeof dns.promises.resolve;

  vi.spyOn(dns.promises, 'resolve').mockImplementation(resolve);
  const createClient = vi.fn((uri: string) => new MongoClient(uri));

  const client = new ServerlessMongoClient('mongodb+srv://cluster.localhost/app', { createClient });

  try {
    await expect(client.db().collection('unused').findOne({})).rejects.toThrow(error);
    expect(createClient).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
});

it('keeps explicit authentication and replica-set options ahead of TXT defaults', async () => {
  stubSrvRecords(27017, 'authSource=txt-db&replicaSet=txt-set');

  const resolved = await resolveSeeds('mongodb+srv://user:password@cluster.localhost/app?authSource=uri-db&replicaSet=uri-set', {
    authSource: 'option-db', replicaSet: 'option-set', srvServiceName: 'custom'
  });

  expect(resolved.options.authSource).toBe('option-db');
  expect(resolved.options.replicaSet).toBe('option-set');
  expect(resolved.options.srvServiceName).toBeUndefined();
  expect(resolved.options.srvMaxHosts).toBeUndefined();
  expect(resolved.options.tls).toBe(true);
});

it.each([
  'mongodb+srv://cluster.localhost/?directConnection=true',
  'mongodb://a:27017,b:27017/?directConnection=true',
  'mongodb://a:27017/?srvServiceName=custom'
])('preserves native validation of %s', async uri => {
  expect(() => new MongoClient(uri)).toThrow();
  await expect(resolveSeeds(uri)).rejects.toThrow();
});

it('resolves seeds without collecting handshake metadata for an unused client', async () => {
  const platform = vi.fn(() => 'test-platform');

  await resolveSeeds('mongodb://localhost:27017/app', {
    runtimeAdapters: { os: {
      platform,
      arch: () => 'test-architecture',
      release: () => 'test-release',
      type: () => 'test-type'
    } }
  });

  expect(platform).not.toHaveBeenCalled();
});
