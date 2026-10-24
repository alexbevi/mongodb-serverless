import { EventEmitter } from 'node:events';
import { ReadPreference, type ReadPreferenceMode, type ServerDescription as NativeServerDescription, type Document, type TopologyDescription as NativeTopologyDescription } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { ServerlessMongoClient } from '../../src/client.js';
import { requireMongo } from '../../src/native.js';
import { TestPlugin } from '../harness/plugin.js';

const { ServerDescription }: { ServerDescription: new (address: string, hello: Document, options: Pick<NativeServerDescription, 'roundTripTime'>) => NativeServerDescription } = requireMongo('./sdam/server_description.js');

const { TopologyDescription }: { TopologyDescription: typeof NativeTopologyDescription } = requireMongo('./sdam/topology_description.js');

const selectors: {
  readPreferenceServerSelector(preference: ReadPreference): (topology: NativeTopologyDescription, servers: NativeServerDescription[], deprioritized: Deprioritized) => NativeServerDescription[];
  DeprioritizedServers: new () => Deprioritized;
} = requireMongo('./sdam/server_selection.js');

interface Deprioritized {
  has(server: NativeServerDescription): boolean;
}

interface Member {
  address: string;
  primary?: boolean;
  tags?: { region: string };
  latency?: number;
  lagSeconds?: number;
}

interface Selection {
  address?: string;
  error?: string;
}

interface Scenario {
  name: string;
  members: Member[];
  preference: ReadPreference;
  eligible: string[];
  threshold?: number;
  knownGap?: boolean;
}

const primary: Member = { address: 'a:27017', primary: true, tags: { region: 'east' } };

const secondary: Member = { address: 'b:27017', tags: { region: 'east' } };

const otherSecondary: Member = { address: 'c:27017', tags: { region: 'west' } };

const members = [primary, secondary, otherSecondary];

const modes: ReadPreferenceMode[] = ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'];

const scenarios: Scenario[] = [];

for (const mode of modes) {
  scenarios.push(
    {
      name: `${mode}: primary and secondaries`, members, preference: new ReadPreference(mode),
      eligible: mode === 'nearest' ? members.map(member => member.address)
        : mode.startsWith('primary') ? [primary.address] : [secondary.address, otherSecondary.address]
    },
    {
      name: `${mode}: only primary available`, members: [primary], preference: new ReadPreference(mode),
      eligible: mode === 'secondary' ? [] : [primary.address], knownGap: mode === 'secondary'
    },
    {
      name: `${mode}: no primary available`, members: [secondary, otherSecondary], preference: new ReadPreference(mode),
      eligible: mode === 'primary' ? [] : [secondary.address, otherSecondary.address], knownGap: mode !== 'primary'
    }
  );
}

for (const mode of ['primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'] as const) {
  const prefersPrimary = mode === 'primaryPreferred';
  scenarios.push(
    {
      name: `${mode}: ordered tag fallback`, members,
      preference: new ReadPreference(mode, [{ region: 'absent' }, { region: 'west' }, {}]),
      eligible: [prefersPrimary ? primary.address : otherSecondary.address], knownGap: !prefersPrimary
    },
    {
      name: `${mode}: empty tag fallback accepts any member`, members,
      preference: new ReadPreference(mode, [{ region: 'absent' }, {}]),
      eligible: prefersPrimary ? [primary.address]
        : mode === 'nearest' ? members.map(member => member.address) : [secondary.address, otherSecondary.address]
    },
    {
      name: `${mode}: no tag match`, members,
      preference: new ReadPreference(mode, [{ region: 'absent' }]),
      eligible: prefersPrimary || mode === 'secondaryPreferred' ? [primary.address] : [], knownGap: !prefersPrimary
    },
    {
      name: `${mode}: stale first secondary`, members: [primary, { ...secondary, lagSeconds: 120 }, otherSecondary],
      preference: new ReadPreference(mode, undefined, { maxStalenessSeconds: 90 }),
      eligible: prefersPrimary ? [primary.address]
        : mode === 'nearest' ? [primary.address, otherSecondary.address] : [otherSecondary.address], knownGap: !prefersPrimary
    },
    {
      name: `${mode}: every secondary is stale`, members: [primary, { ...secondary, lagSeconds: 120 }, { ...otherSecondary, lagSeconds: 130 }],
      preference: new ReadPreference(mode, undefined, { maxStalenessSeconds: 90 }),
      eligible: mode === 'secondary' ? [] : [primary.address], knownGap: !prefersPrimary
    },
    {
      name: `${mode}: staleness without a primary`, members: [{ ...secondary, lagSeconds: 120 }, otherSecondary],
      preference: new ReadPreference(mode, undefined, { maxStalenessSeconds: 90 }),
      eligible: [otherSecondary.address], knownGap: true
    }
  );
}

scenarios.push(
  {
    name: 'nearest: fastest member is primary', members: [primary, { ...secondary, latency: 100 }, { ...otherSecondary, latency: 110 }],
    preference: ReadPreference.nearest, eligible: [primary.address], knownGap: true
  },
  {
    name: 'secondary: exclude a slow first secondary', members: [primary, { ...secondary, latency: 100 }, otherSecondary],
    preference: ReadPreference.secondary, eligible: [otherSecondary.address], knownGap: true
  },
  {
    name: 'secondary: a wider latency window admits both', members: [primary, { ...secondary, latency: 100 }, otherSecondary],
    preference: ReadPreference.secondary, threshold: 110, eligible: [secondary.address, otherSecondary.address]
  },
  {
    name: 'primary: latency does not change the required role', members: [{ ...primary, latency: 100 }, secondary, otherSecondary],
    preference: ReadPreference.primary, eligible: [primary.address]
  },
  {
    name: 'nearest: tags select only the primary', members: [{ ...primary, tags: { region: 'primary' } }, secondary, otherSecondary],
    preference: new ReadPreference('nearest', [{ region: 'primary' }]), eligible: [primary.address], knownGap: true
  },
  {
    name: 'secondary: staleness filters before ordered tags', members: [primary, { ...secondary, lagSeconds: 120 }, otherSecondary],
    preference: new ReadPreference('secondary', [{ region: 'east' }, { region: 'west' }], { maxStalenessSeconds: 90 }),
    eligible: [otherSecondary.address], knownGap: true
  }
);

function description(member: Member): NativeServerDescription {
  const server = new ServerDescription(member.address, {
    ok: 1, setName: 'rs', isWritablePrimary: member.primary === true, secondary: !member.primary,
    minWireVersion: 0, maxWireVersion: 25, hosts: members.map(member => member.address),
    tags: member.tags, lastWrite: { lastWriteDate: 1_000_000 - (member.lagSeconds ?? 0) * 1000 }
  }, { roundTripTime: member.latency ?? 1 });

  server.lastUpdateTime = 2_000_000;

  return server;
}

function nativeCandidates(scenario: Scenario): string[] {
  const servers = scenario.members.map(description);

  const topology = new TopologyDescription(
    scenario.members.some(member => member.primary) ? 'ReplicaSetWithPrimary' : 'ReplicaSetNoPrimary',
    new Map(servers.map(server => [server.address, server])), 'rs', null, null, 25,
    { heartbeatFrequencyMS: 10_000, localThresholdMS: scenario.threshold ?? 15 }
  );

  const select = selectors.readPreferenceServerSelector(scenario.preference);

  return select(topology, servers, new selectors.DeprioritizedServers()).map(server => server.address);
}

async function wrapperSelection(scenario: Scenario): Promise<Selection> {
  const selected: Selection = {};

  const client = new ServerlessMongoClient('mongodb://seed:27017/preferences', {
    localThresholdMS: scenario.threshold ?? 15,
    plugin: new TestPlugin({ set: 'rs', members: scenario.members.map(member => ({
      name: member.address, stateStr: member.primary ? 'PRIMARY' : 'SECONDARY', health: 1
    })) }),
    createClient(uri) {
      const member = scenario.members.find(member => member.address === new URL(uri).host);

      if (!member) throw new Error(`Unexpected target: ${uri}`);
      const server = description(member);
      const events = new EventEmitter();

      // SAFETY: The fake reports a native server description and records findOne after connect.
      return {
        on: events.on.bind(events),
        async connect() { events.emit('serverDescriptionChanged', { newDescription: server }); },
        async close() {},
        db: () => ({ collection: () => ({
          async findOne() {
            selected.address = server.address;

            return null;
          }
        }) })
      } as never;
    }
  });

  try {
    await client.db('preferences').collection('records').findOne({}, { readPreference: scenario.preference });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NoPrimaryError') throw error;
    selected.error = error.name;
  } finally {
    await client.close();
  }

  return selected;
}

it('pins the native server-selection oracle', () => {
  const manifest: { version: string } = requireMongo('../package.json');
  expect(manifest.version).toBe('7.7.0');
});

// Synthetic descriptions make lag and latency deterministic without delaying a live replica set.
describe.each(scenarios)('$name', scenario => {
  it('native selector returns the expected candidates', () => {
    expect(nativeCandidates(scenario).sort()).toEqual([...scenario.eligible].sort());
  });

  const check = scenario.knownGap && process.env['MONGODB_NATIVE_PARITY'] !== '1' ? it.fails : it;

  check(scenario.knownGap ? 'known gap: wrapper must select an eligible member' : 'wrapper selects an eligible member or refuses the operation', async () => {
    const selected = await wrapperSelection(scenario);

    if (scenario.eligible.length === 0) {
      expect(selected.address).toBeUndefined();
      expect(selected.error).toBeDefined();
    } else {
      expect(selected.error).toBeUndefined();
      expect(scenario.eligible).toContain(selected.address);
    }
  });
});
