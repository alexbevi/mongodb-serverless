import type { CommandStartedEvent } from 'mongodb';
import { expect, it } from 'vitest';
import { ServerlessMongoClient } from '../../src/client.js';
import { startCluster, describeCluster } from '../../../test/harness/cluster.js';

it('discovers and routes without a plugin', async () => {
  await startCluster();
  const cluster = await describeCluster();
  const commands: CommandStartedEvent[] = [];

  const client = new ServerlessMongoClient(cluster.uri, {
    monitorCommands: true,
    on: { commandStarted: event => commands.push(event) }
  });

  try {
    const collection = client.db('bootstrap').collection('withoutPlugin');
    await collection.insertOne({ value: 1 });
    await collection.findOne({ value: 1 });

    expect(commands.filter(event => event.commandName === 'replSetGetStatus')).toHaveLength(1);
    expect(commands.find(event => event.commandName === 'insert')?.address.split(':').at(-1)).toBe(cluster.primary.split(':').at(-1));
    expect(cluster.secondaries.map(host => host.split(':').at(-1))).toContain(
      commands.find(event => event.commandName === 'find')?.address.split(':').at(-1)
    );
  } finally {
    await client.close().catch(() => {});
  }
}, 120_000);
