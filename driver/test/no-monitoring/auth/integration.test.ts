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
