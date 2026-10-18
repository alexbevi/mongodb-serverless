import { MongoClient } from 'mongodb';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerlessMongoClient } from '../../src/client.js';
import { startSecureCluster } from '../../../test/harness/secure-cluster.js';
import { startRelay } from '../../../test/harness/relay.js';
import { localLookup, stubSrvRecords } from '../../../test/harness/srv.js';
import { SerializedPlugin } from '../harness/serialized-plugin.js';

afterEach(() => vi.restoreAllMocks());

it('resolves SRV and TXT before opening one authenticated application socket', async () => {
  const fixture = await startSecureCluster();
  const relay = await startRelay(29400);
  const dns = stubSrvRecords(relay.port);
  const built: MongoClient[] = [];

  const client = new ServerlessMongoClient('mongodb+srv://test:fixture-password@cluster.localhost/app', {
    disableMonitoring: true, maxPoolSize: 1, tlsCAFile: fixture.ca,
    servername: 'localhost', lookup: localLookup,
    createClient(uri, options) {
      const native = new MongoClient(uri, options);
      built.push(native);

      return native;
    }
  });

  try {
    await client.db().collection('srvBootstrap').insertOne({ value: 1 });
    expect(built).toHaveLength(1);
    expect(built[0]?.options.directConnection).toBe(true);
    expect(built[0]?.options.credentials?.source).toBe('admin');
    expect(built[0]?.options.tls).toBe(true);
    expect(relay.counts.accepted).toBe(1);
    expect(dns).toHaveBeenCalledTimes(2);
    await client.db().collection('srvBootstrap').findOne({ value: 1 });
    expect(relay.counts.accepted).toBe(1);
    expect(dns).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await relay.close();
  }

  expect(relay.counts.open).toBe(0);
}, 120_000);

it('preserves an explicit TLS opt-out in bootstrap and cached connections', async () => {
  await startSecureCluster();
  const dns = stubSrvRecords(29400);
  const plugin = new SerializedPlugin();
  const built: MongoClient[] = [];

  for (let run = 0; run < 2; run++) {
    const client = new ServerlessMongoClient('mongodb+srv://test:fixture-password@cluster.localhost/app', {
      plugin, tls: false, disableMonitoring: true, maxPoolSize: 1, lookup: localLookup,
      createClient(uri, options) {
        const native = new MongoClient(uri, options);
        built.push(native);

        return native;
      }
    });

    try {
      await client.db().collection('tlsOptOut').insertOne({ run });
      expect(built.at(-1)?.options.tls).toBe(false);
      expect(built.at(-1)?.options.credentials?.source).toBe('admin');
    } finally {
      await client.close();
    }
  }

  expect(built).toHaveLength(2);
  expect(dns).toHaveBeenCalledTimes(2);
}, 120_000);
