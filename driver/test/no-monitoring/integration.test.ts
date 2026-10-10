import { MongoClient } from 'mongodb';
import { beforeAll, expect, it } from 'vitest';
import { startCluster, describeCluster } from '../../../test/harness/cluster.js';
import { startRelay } from '../../../test/harness/relay.js';
import { disableMonitoring } from '../../src/no-monitoring/index.js';

let targetPort: number;

beforeAll(async () => {
  await startCluster();
  targetPort = Number((await describeCluster()).primary.split(':')[1]);
}, 120_000);

it('uses the authenticated bootstrap socket for the first application command', async () => {
  const relay = await startRelay(targetPort);

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, maxPoolSize: 1, minPoolSize: 0, monitorCommands: true,
    serverSelectionTimeoutMS: 2000
  }));

  const events: string[] = [];
  client.on('connectionCreated', () => events.push('created'));
  client.on('connectionReady', () => events.push('ready'));
  client.on('connectionCheckedOut', () => events.push('checkout'));

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    expect(relay.counts.accepted).toBe(1);
    expect(events.slice(0, 3)).toEqual(['created', 'ready', 'checkout']);
  } finally {
    await client.close();
    await relay.close();
  }

  expect(relay.counts.open).toBe(0);
});

it('rejects activation after native connect has started', async () => {
  const client = new MongoClient(`mongodb://127.0.0.1:${targetPort}`, { directConnection: true });

  try {
    await client.connect();
    expect(() => disableMonitoring(client)).toThrow(/before/);
  } finally {
    await client.close();
  }
});
