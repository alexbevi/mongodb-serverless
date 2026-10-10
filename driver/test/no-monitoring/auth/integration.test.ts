import { MongoClient } from 'mongodb';
import { expect, it } from 'vitest';
import { startSecureCluster } from '../../../../test/harness/secure-cluster.js';

it('provides a SCRAM and verified TLS replica set fixture', async () => {
  const fixture = await startSecureCluster();
  const client = new MongoClient(fixture.uri, { directConnection: true, tls: true, tlsCAFile: fixture.ca });

  try {
    await client.db('admin').command({ listDatabases: 1 });
  } finally {
    await client.close();
  }

  expect(fixture.uri).toContain('localhost:29400');
}, 120_000);

import { startRelay } from '../../../../test/harness/relay.js';
import { disableMonitoring } from '../../../src/no-monitoring/index.js';

for (const authMechanism of ['DEFAULT', 'SCRAM-SHA-256', 'SCRAM-SHA-1'] as const) {
  it(`authenticates the first socket with ${authMechanism}`, async () => {
    const fixture = await startSecureCluster();
    const relay = await startRelay(29400);

    const client = disableMonitoring(new MongoClient(fixture.uri.replace('29400', String(relay.port)), {
      directConnection: true, maxPoolSize: 1, authMechanism, tls: true, tlsCAFile: fixture.ca
    }));

    try {
      await client.db('admin').command({ listDatabases: 1 });
      expect(relay.counts.accepted).toBe(1);
    } finally {
      await client.close();
      await relay.close();
    }
  });
}

it('preserves authentication errors and closes the failed socket without idle retries', async () => {
  const fixture = await startSecureCluster();
  const relay = await startRelay(29400);

  const client = disableMonitoring(new MongoClient(fixture.uri.replace('29400', String(relay.port)).replace('fixture-password', 'wrong'), {
    directConnection: true, serverSelectionTimeoutMS: 1000
  }));

  try {
    await expect(client.connect()).rejects.toMatchObject({ name: 'MongoServerError', code: 18 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(relay.counts).toEqual({ accepted: 1, open: 0, closed: 1, peak: 1 });
    await expect(client.connect()).rejects.toMatchObject({ code: 18 });
    expect(relay.counts.accepted).toBe(2);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('rejects an untrusted TLS certificate without adopting the socket', async () => {
  const fixture = await startSecureCluster();
  const relay = await startRelay(29400);

  const client = disableMonitoring(new MongoClient(fixture.uri.replace('29400', String(relay.port)), {
    directConnection: true, tls: true, serverSelectionTimeoutMS: 1000
  }));

  let ready = 0;
  client.on('connectionReady', () => ready++);

  try {
    await expect(client.connect()).rejects.toThrow(/self-signed certificate/);
    expect(ready).toBe(0);
  } finally {
    await client.close();
    await relay.close();
  }
});
