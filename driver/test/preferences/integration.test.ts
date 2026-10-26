import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, ReadConcern, ReadPreference, type CommandStartedEvent, type DbOptions, type Db, type MongoClientOptions, type ReadPreferenceMode, type Document } from 'mongodb';
import { ServerlessMongoClient } from '../../src/client.js';
import { startCluster, describeCluster, type TestCluster } from '../../../test/harness/cluster.js';
import { TestPlugin } from '../harness/plugin.js';

interface Client {
  db(name?: string, options?: DbOptions): Db;
  close(): Promise<void>;
}

interface Observation {
  commands: CommandStartedEvent[];
  error?: Error;
}

interface Scenario {
  name: string;
  options?: MongoClientOptions;
  query?: string;
  run(client: Client): Promise<Document | Document[] | null>;
  role?: 'primary' | 'secondary' | 'either';
  error?: string;
  wire?: Document;
  knownGap?: boolean;
}

let cluster: TestCluster;

const database = `preferences_${Date.now()}`;

const unexpectedErrors: unknown[] = [];

const records = (client: Client) => client.db(database).collection('records');

const modes: ReadPreferenceMode[] = ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'];

const primaryOptions = { readPreference: 'primary' } as const;

const concern = { w: 'majority', j: true, wtimeoutMS: 9876 } as const;

const scenarios: Scenario[] = modes.flatMap(mode => ['string', 'object'].map(representation => ({
  name: `${mode} as ${representation}`,
  run: (client: Client) => records(client).findOne({}, {
    readPreference: representation === 'string' ? mode : new ReadPreference(mode)
  }),
  role: mode === 'nearest' ? 'either' : mode.startsWith('primary') ? 'primary' : 'secondary'
})));

scenarios.push(
  { name: 'default read preference', run: c => records(c).findOne({}), role: 'primary', knownGap: true },
  { name: 'URI read preference', query: '&readPreference=primary', run: c => records(c).findOne({}), role: 'primary', knownGap: true },
  { name: 'client read preference', options: primaryOptions, run: c => records(c).findOne({}), role: 'primary', knownGap: true },
  { name: 'database read preference', run: c => c.db(database, primaryOptions).collection('records').findOne({}), role: 'primary', knownGap: true },
  { name: 'collection read preference', run: c => c.db(database).collection('records', primaryOptions).findOne({}), role: 'primary', knownGap: true },
  { name: 'cursor read preference', run: c => records(c).find({}).withReadPreference('primary').toArray(), role: 'primary', knownGap: true },
  { name: 'operation overrides client preference', options: { readPreference: 'secondary' }, run: c => records(c).findOne({}, primaryOptions), role: 'primary' },
  { name: 'query field is not an option', run: c => records(c).findOne({ readPreference: 'primary' }, { readPreference: 'secondary' }), role: 'secondary', knownGap: true },
  { name: 'generic read command', run: c => c.db(database).command({ find: 'records', filter: {}, limit: 1 }, { readPreference: 'secondary' }), role: 'secondary', knownGap: true },
  { name: 'generic cursor command with ReadPreference object', run: c => c.db(database).runCursorCommand({ find: 'records', filter: {} }, { readPreference: ReadPreference.secondary }).toArray(), role: 'secondary', knownGap: true },
  { name: 'native 7.7.0 ignores a generic cursor command string preference', run: c => c.db(database).runCursorCommand({ find: 'records', filter: {} }, { readPreference: 'secondary' }).toArray(), role: 'primary' },
  { name: 'generic cursor command with withReadPreference', run: c => c.db(database).runCursorCommand({ find: 'records', filter: {} }).withReadPreference('secondary').toArray(), role: 'secondary', knownGap: true },
  { name: 'aggregation with $out', run: c => records(c).aggregate([{ $match: { value: 'seed' } }, { $out: 'output' }], { readPreference: 'secondary' }).toArray(), role: 'secondary', knownGap: true },
  { name: 'aggregation with $merge', run: c => records(c).aggregate([{ $match: { value: 'seed' } }, { $merge: 'output' }], { readPreference: 'secondary' }).toArray(), role: 'secondary', knownGap: true }
);

for (const mode of ['secondary', 'secondaryPreferred', 'nearest'] as const) {
  scenarios.push({
    name: `${mode} with no matching tags`, knownGap: true,
    run: c => records(c).findOne({}, { readPreference: new ReadPreference(mode, [{ region: 'absent' }]) }),
    ...(mode === 'secondaryPreferred' ? { role: 'primary' } as const : { error: 'MongoServerSelectionError' })
  });
}

for (const mode of modes) {
  scenarios.push({
    name: `write ignores ${mode} read preference`, options: { readPreference: mode },
    run: c => records(c).insertOne({ value: mode }), role: 'primary'
  });
}

for (const mode of modes) {
  scenarios.push(
    { name: `update ignores ${mode} read preference`, options: { readPreference: mode }, run: c => records(c).updateOne({ value: 'seed' }, { $set: { updated: true } }), role: 'primary' },
    { name: `delete ignores ${mode} read preference`, options: { readPreference: mode }, run: c => records(c).deleteOne({ value: 'absent' }), role: 'primary' }
  );
}

for (const mode of modes.filter(mode => mode !== 'primary')) {
  const role = mode === 'nearest' ? 'either' : mode === 'primaryPreferred' ? 'primary' : 'secondary';
  const knownGap = mode === 'primaryPreferred';
  scenarios.push(
    { name: `URI inherits ${mode}`, query: `&readPreference=${mode}`, run: c => records(c).findOne({}), role, knownGap },
    { name: `client inherits ${mode}`, options: { readPreference: mode }, run: c => records(c).findOne({}), role, knownGap },
    { name: `database inherits ${mode}`, run: c => c.db(database, { readPreference: mode }).collection('records').findOne({}), role, knownGap },
    { name: `collection inherits ${mode}`, run: c => c.db(database).collection('records', { readPreference: mode }).findOne({}), role, knownGap },
    { name: `cursor selects ${mode}`, run: c => records(c).find({}).withReadPreference(mode).toArray(), role, knownGap }
  );
}

for (const writeConcern of [{ w: 0 }, { w: 1 }, { w: 3 }, { w: 'majority' }, { w: 1, j: true }, { w: 1, j: false }, concern] as const) {
  scenarios.push({
    name: `operation write concern ${JSON.stringify(writeConcern)}`,
    run: c => records(c).insertOne({ value: 'concern' }, { writeConcern }), role: 'primary',
    wire: { writeConcern: writeConcern === concern ? { w: 'majority', j: true, wtimeout: 9876 } : writeConcern }
  });
}

scenarios.push(
  { name: 'URI write concern', query: '&w=majority&journal=true&wtimeoutMS=9876', run: c => records(c).insertOne({ value: 'uri' }), role: 'primary', wire: { writeConcern: { w: 'majority', j: true, wtimeout: 9876 } } },
  { name: 'operation overrides client write concern', options: { writeConcern: concern }, run: c => records(c).insertOne({ value: 'override' }, { writeConcern: { w: 1 } }), role: 'primary', wire: { writeConcern: { w: 1 } } },
  { name: 'client write concern', options: { writeConcern: concern }, run: c => records(c).insertOne({ value: 'client' }), role: 'primary', wire: { writeConcern: { w: 'majority', j: true, wtimeout: 9876 } } },
  { name: 'database write concern', run: c => c.db(database, { writeConcern: concern }).collection('records').insertOne({ value: 'database' }), role: 'primary', wire: { writeConcern: { w: 'majority', j: true, wtimeout: 9876 } }, knownGap: true },
  { name: 'collection write concern', run: c => c.db(database).collection('records', { writeConcern: concern }).insertOne({ value: 'collection' }), role: 'primary', wire: { writeConcern: { w: 'majority', j: true, wtimeout: 9876 } }, knownGap: true }
);

for (const level of ['local', 'available', 'majority', 'linearizable', 'snapshot'] as const) {
  scenarios.push({
    name: `operation read concern ${level}`,
    run: c => records(c).findOne({}, { ...primaryOptions, readConcern: { level } }),
    role: 'primary', wire: { readConcern: { level } }
  });
}

scenarios.push(
  { name: 'client read concern', options: { readConcern: { level: 'majority' } }, run: c => records(c).findOne({}, primaryOptions), role: 'primary', wire: { readConcern: { level: 'majority' } } },
  { name: 'database read concern', run: c => c.db(database, { readConcern: new ReadConcern('majority') }).collection('records').findOne({}, primaryOptions), role: 'primary', wire: { readConcern: { level: 'majority' } }, knownGap: true },
  { name: 'collection read concern', run: c => c.db(database).collection('records', { readConcern: { level: 'majority' } }).findOne({}, primaryOptions), role: 'primary', wire: { readConcern: { level: 'majority' } }, knownGap: true }
);

beforeAll(async () => {
  await startCluster();
  cluster = await describeCluster();
  const native = new MongoClient(cluster.uri);

  try {
    await records(native).insertOne({ value: 'seed' }, { writeConcern: { w: 3 } });
  } finally {
    await native.close();
  }
}, 60_000);

afterAll(async () => {
  const native = new MongoClient(cluster.uri);

  try {
    await native.db(database).dropDatabase();
  } finally {
    await native.close();
  }

  // Expected failures must not hide connection, fixture, or authentication errors.
  expect(unexpectedErrors).toEqual([]);
});

async function observe(scenario: Scenario, wrapper: boolean, disableMonitoring = false): Promise<Observation> {
  const observation: Observation = { commands: [] };

  const listener = (event: CommandStartedEvent) => {
    if (['find', 'insert', 'update', 'delete', 'aggregate'].includes(event.commandName)) observation.commands.push(event);
  };

  const uri = cluster.uri + (scenario.query ?? '');
  const options = { serverSelectionTimeoutMS: 700, connectTimeoutMS: 700, monitorCommands: true, ...scenario.options };

  const client = wrapper
    ? new ServerlessMongoClient(uri, { ...options, disableMonitoring, plugin: new TestPlugin(cluster.status), on: { commandStarted: listener } })
    : new MongoClient(uri, options);

  try {
    if (!wrapper && client instanceof MongoClient) {
      client.on('commandStarted', listener);
      await discoverAllMembers(client);
    }

    await scenario.run(client);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    observation.error = error;

    if (error.name !== scenario.error) unexpectedErrors.push({ scenario: scenario.name, wrapper, disableMonitoring, error });
  } finally {
    await client.close();
  }

  return observation;
}

async function discoverAllMembers(client: MongoClient): Promise<void> {
  let ready!: () => void;
  const discovered = new Promise<void>(resolve => { ready = resolve; });

  client.on('topologyDescriptionChanged', event => {
    const known = [...event.newDescription.servers.values()].filter(server => ['RSPrimary', 'RSSecondary'].includes(server.type));

    if (known.length === 3) ready();
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await client.connect();

    await Promise.race([
      discovered,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Native fixture did not discover all members')), 3000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertPreference(scenario: Scenario, observed: Observation): void {
  expect(observed.error?.name).toBe(scenario.error);

  if (scenario.error) {
    expect(observed.commands).toHaveLength(0);

    return;
  }

  expect(observed.commands).toHaveLength(1);
  const command = observed.commands[0]!;

  const candidates = scenario.role === 'primary' ? [cluster.primary]
    : scenario.role === 'secondary' ? cluster.secondaries : [cluster.primary, ...cluster.secondaries];

  expect(candidates.map(host => host.split(':').at(-1))).toContain(command.address.split(':').at(-1));

  for (const [field, expected] of Object.entries(scenario.wire ?? {})) {
    expect(command.command[field]).toEqual(expected);
  }
}

describe.each(scenarios)('$name', scenario => {
  it('native replica-set semantics', async () => {
    assertPreference(scenario, await observe(scenario, false));
  });

  const check = scenario.knownGap && process.env['MONGODB_NATIVE_PARITY'] !== '1' ? it.fails : it;

  for (const disableMonitoring of [false, true]) {
    const result = scenario.knownGap ? 'known gap: wrapper must match native semantics' : 'wrapper matches native semantics';

    check(`${result}, disableMonitoring=${disableMonitoring}`, async () => {
      assertPreference(scenario, await observe(scenario, true, disableMonitoring));
    });
  }
});
