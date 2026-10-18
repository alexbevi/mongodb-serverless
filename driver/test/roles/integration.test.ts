import { expect, it, vi } from 'vitest';
import type { CommandStartedEvent } from 'mongodb';
import { ServerlessMongoClient } from '../../src/client.js';
import { TestPlugin } from '../harness/plugin.js';
import { startCluster, describeCluster } from '../../../test/harness/cluster.js';

const portOf = (host: string): string | undefined => host.split(':').at(-1);

it('refreshes mismatched cached roles before sending a read and stores them for the next cold start', async () => {
  await startCluster();
  const cluster = await describeCluster();

  const stale = {
    ...cluster.status,
    members: cluster.status.members.map(member => ({
      ...member,
      state: member.name === cluster.secondaries[0] ? 1 : 2,
      stateStr: member.name === cluster.secondaries[0] ? 'PRIMARY' : 'SECONDARY'
    }))
  };

  for (const disableMonitoring of [false, true]) {
    for (const readPreference of ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'] as const) {
      const plugin = new TestPlugin(stale);
      const stored = vi.spyOn(plugin, 'write');

      for (const coldStart of [1, 2]) {
        const commands: CommandStartedEvent[] = [];

        const client = new ServerlessMongoClient(cluster.uri, {
          plugin, disableMonitoring, maxPoolSize: 1, monitorCommands: true,
          on: { commandStarted: event => commands.push(event) }
        });

        try {
          const concurrentReads = coldStart === 1 ? 4 : 1;
          await Promise.all(Array.from({ length: concurrentReads }, () =>
            client.db('role_validation').collection('records').findOne({}, { readPreference })
          ));

          const reads = commands.filter(event => event.commandName === 'find');
          expect(reads).toHaveLength(concurrentReads);

          const expected = readPreference === 'nearest' ? [cluster.primary, ...cluster.secondaries]
            : readPreference.startsWith('primary') ? [cluster.primary] : cluster.secondaries;

          for (const read of reads) expect(expected.map(portOf)).toContain(portOf(read.address));
          expect(commands.filter(event => event.commandName === 'replSetGetStatus'))
            .toHaveLength(coldStart === 1 ? 1 : 0);
          expect(commands.filter(event => event.commandName === 'hello'))
            .toHaveLength(coldStart === 1 ? 1 : 0);
          expect(stored).toHaveBeenCalledTimes(1);
          expect(await plugin.read()).toMatchObject({
            members: expect.arrayContaining([
              expect.objectContaining({ name: cluster.primary, stateStr: 'PRIMARY' }),
              ...cluster.secondaries.map(name => expect.objectContaining({ name, stateStr: 'SECONDARY' }))
            ])
          });
        } finally {
          await client.close();
        }
      }
    }
  }
}, 60_000);
