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

it('leaves ordinary monitoring active and emits no heartbeat in either opted-in mode', async () => {
  for (const serverMonitoringMode of ['poll', 'stream'] as const) {
    const relay = await startRelay(targetPort);
    const stockRelay = await startRelay(targetPort);
    const options = { directConnection: true, maxPoolSize: 1, heartbeatFrequencyMS: 500, serverMonitoringMode };
    const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, options));
    const stock = new MongoClient(`mongodb://127.0.0.1:${stockRelay.port}`, options);
    const heartbeats: string[] = [];
    client.on('serverHeartbeatStarted', () => heartbeats.push('started'));

    try {
      await Promise.all([client.connect(), stock.connect()]);
      expect(disableMonitoring(client)).toBe(client);
      // SAFETY: connect initialized this pinned driver's topology and monitor object.
      const native = client as MongoClient & { topology: import('../../src/no-monitoring/adapter.js').Topology };
      const monitor = native.topology.s.servers.values().next().value?.monitor;

      if (!monitor) throw new Error('Missing inert monitor');
      monitor.reset();
      monitor.requestCheck();
      expect(monitor.connection).toBeNull();
      expect(monitor.monitorId).toBeUndefined();
      expect(monitor.rttPinger).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(relay.counts.accepted).toBe(1);
      expect(heartbeats).toEqual([]);
      expect(stockRelay.counts.accepted).toBe(serverMonitoringMode === 'poll' ? 2 : 3);
    } finally {
      await Promise.all([client.close(), stock.close()]);
      await Promise.all([relay.close(), stockRelay.close()]);
    }
  }
});

it('rejects a mismatched replica set before the connection becomes ready', async () => {
  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${targetPort}`, {
    directConnection: true, replicaSet: 'wrong', serverSelectionTimeoutMS: 300
  }));

  let ready = 0;
  client.on('connectionReady', () => ready++);

  try {
    await expect(client.connect()).rejects.toThrow(/replica set/i);
    expect(ready).toBe(0);
  } finally {
    await client.close();
  }
});

it('rejects a standalone before connection readiness', async () => {
  const { startStandalone, STANDALONE_PORT } = await import('../../../test/harness/cluster.js');
  await startStandalone();

  const client = disableMonitoring(new MongoClient(`mongodb://localhost:${STANDALONE_PORT}`, {
    directConnection: true, serverSelectionTimeoutMS: 500
  }));

  let ready = 0;
  client.on('connectionReady', () => ready++);

  try {
    await expect(client.connect()).rejects.toThrow(/data-bearing replica set member/);
    expect(ready).toBe(0);
  } finally {
    await client.close();
  }
}, 60_000);

it('recovers on the same secondary after a rejected write without exceeding the pool limit', async () => {
  const secondary = (await describeCluster()).secondaries[0];

  if (!secondary) throw new Error('Missing secondary');
  const relay = await startRelay(Number(secondary.split(':')[1]));

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, maxPoolSize: 1, retryWrites: false, serverSelectionTimeoutMS: 1500
  }));

  try {
    await client.connect();
    await expect(client.db('test').collection('recovery').insertOne({ value: 1 })).rejects.toMatchObject({ code: 10107 });
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(relay.counts.accepted).toBe(1);
    await client.db('test').collection('recovery').findOne({});
    expect(relay.counts.peak).toBe(1);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('removes stale available connections before reserving a recovery connection', async () => {
  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${targetPort}`, {
    directConnection: true, maxPoolSize: 1, serverSelectionTimeoutMS: 1000
  }));

  try {
    await client.connect();
    // SAFETY: mongodb 7.7.0 exposes topology after connect; this test exercises its real pool.
    const native = client as MongoClient & { topology: import('../../src/no-monitoring/adapter.js').Topology };
    const server = native.topology.s.servers.values().next().value;

    if (!server) throw new Error('Missing server');
    server.pool.clear();
    server.emit('descriptionReceived', new (await import('../../src/no-monitoring/adapter.js')).descriptionModule.ServerDescription(server.description.address, {}));
    let maximum = 0;
    client.on('connectionCreated', () => { maximum = Math.max(maximum, server.pool.totalConnectionCount); });
    await client.db('admin').command({ ping: 1 });
    expect(maximum).toBe(1);
  } finally {
    await client.close();
  }
});

it('finishes pool recovery before returning an already known server', async () => {
  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${targetPort}`, {
    directConnection: true, maxPoolSize: 1, waitQueueTimeoutMS: 200, serverSelectionTimeoutMS: 1000
  }));

  try {
    await client.connect();
    // SAFETY: connect initialized the topology of the pinned mongodb 7.7.0 client.
    const native = client as MongoClient & { topology: import('../../src/no-monitoring/adapter.js').Topology };
    const server = native.topology.s.servers.values().next().value;

    if (!server) throw new Error('Missing server');
    server.pool.clear();
    await expect(client.db('admin').command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
  } finally {
    await client.close();
  }
});

it('waits for a stale checked-out connection to return before reserving recovery capacity', async () => {
  const { descriptionModule } = await import('../../src/no-monitoring/adapter.js');

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${targetPort}`, {
    directConnection: true, maxPoolSize: 1, monitorCommands: true, serverSelectionTimeoutMS: 1000
  }));

  try {
    await client.connect();
    // SAFETY: connect initialized this pinned driver's topology.
    const native = client as MongoClient & { topology: import('../../src/no-monitoring/adapter.js').Topology };
    const server = native.topology.s.servers.values().next().value;

    if (!server) throw new Error('Missing server');
    let recovery: Promise<import('mongodb').Document> | undefined;
    let maximum = 0;
    client.on('connectionCreated', () => { maximum = Math.max(maximum, server.pool.totalConnectionCount); });
    client.once('commandStarted', () => {
      server.pool.clear();
      server.emit('descriptionReceived', new descriptionModule.ServerDescription(server.description.address, {}));
      recovery = client.db('admin').command({ ping: 1 });
    });
    await client.db('admin').command({ ping: 1 });
    await recovery;
    expect(maximum).toBe(1);
  } finally {
    await client.close();
  }
});

it('does not reconnect just to end sessions during close', async () => {
  const relay = await startRelay(targetPort);

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, maxPoolSize: 1
  }));

  try {
    await client.db('admin').command({ ping: 1 });
    relay.interrupt(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    await client.close();
    expect(relay.counts.accepted).toBe(1);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('cancels recovery when its last waiting operation times out', async () => {
  const relay = await startRelay(targetPort);

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, maxPoolSize: 1, serverSelectionTimeoutMS: 1000
  }));

  try {
    await client.connect();
    // SAFETY: connect initialized this pinned driver's topology.
    const native = client as MongoClient & { topology: import('../../src/no-monitoring/adapter.js').Topology };
    const server = native.topology.s.servers.values().next().value;

    if (!server) throw new Error('Missing server');
    server.pool.clear();
    relay.pause();
    await expect(client.db('admin').command({ ping: 1 }, { timeoutMS: 80 })).rejects.toMatchObject({ name: 'MongoOperationTimeoutError' });
    relay.resume();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(relay.counts.open).toBe(0);
    await client.db('admin').command({ ping: 1 });
    expect(relay.counts.accepted).toBe(3);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('keeps shared recovery alive when one caller aborts', async () => {
  const relay = await startRelay(targetPort);

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, maxPoolSize: 1, serverSelectionTimeoutMS: 1000
  }));

  try {
    await client.connect();
    // SAFETY: connect initialized this pinned driver's topology.
    const native = client as MongoClient & { topology: import('../../src/no-monitoring/adapter.js').Topology };
    native.topology.s.servers.values().next().value?.pool.clear();
    relay.pause();
    const controller = new AbortController();
    const cancelled = expect(client.db('admin').command({ ping: 1 }, { signal: controller.signal })).rejects.toThrow('cancel caller');
    const survivor = client.db('admin').command({ ping: 1 });
    await expect.poll(() => relay.counts.accepted).toBe(2);
    controller.abort(new Error('cancel caller'));
    await cancelled;
    relay.resume();
    await survivor;
    expect(relay.counts.accepted).toBe(2);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('closes an in-flight bootstrap without adopting a late reply', async () => {
  const relay = await startRelay(targetPort);
  relay.pause();

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, serverSelectionTimeoutMS: 1000
  }));

  let ready = 0;
  client.on('connectionReady', () => ready++);

  try {
    const connecting = expect(client.connect()).rejects.toThrow();
    await expect.poll(() => relay.counts.accepted).toBe(1);
    await client.close();
    relay.resume();
    await connecting;
    await expect.poll(() => relay.counts.open).toBe(0);
    expect(ready).toBe(0);
    await expect(client.db('admin').command({ ping: 1 })).rejects.toThrow();
    expect(relay.counts.accepted).toBe(1);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('shares concurrent bootstrap and preserves minimum and maximum pool settings', async () => {
  for (const size of [1, 3]) {
    const relay = await startRelay(targetPort);

    const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
      directConnection: true, minPoolSize: size === 1 ? 0 : size, maxPoolSize: size
    }));

    try {
      await Promise.all(Array.from({ length: 20 }, () => client.db('admin').command({ ping: 1 })));
      await expect.poll(() => relay.counts.accepted).toBe(size);
      expect(relay.counts.peak).toBe(size);
    } finally {
      await client.close();
      await relay.close();
    }
  }
});

it('replaces an interrupted socket only when the next operation needs it', async () => {
  const relay = await startRelay(targetPort);

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, maxPoolSize: 1, heartbeatFrequencyMS: 500
  }));

  try {
    await client.db('admin').command({ ping: 1 });
    relay.interrupt(1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(relay.counts.accepted).toBe(1);
    await Promise.all(Array.from({ length: 10 }, () => client.db('admin').command({ ping: 1 })));
    expect(relay.counts.accepted).toBe(2);
    expect(relay.counts.peak).toBe(1);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('stays on the selected host through stepdown and preserves retryable write identity', async () => {
  const { stepDownPrimary } = await import('../../../test/harness/cluster.js');
  const primary = (await describeCluster()).primary;
  const relay = await startRelay(Number(primary.split(':')[1]));

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, maxPoolSize: 1, monitorCommands: true, retryWrites: true,
    serverSelectionTimeoutMS: 2000
  }));

  const writes: import('mongodb').CommandStartedEvent[] = [];

  try {
    await client.connect();
    client.on('commandStarted', event => { if (event.commandName === 'insert') writes.push(event); });
    await stepDownPrimary();
    await expect(client.db('test').collection('stepdown').insertOne({ value: 1 })).rejects.toMatchObject({ code: 10107 });
    expect(writes).toHaveLength(2);
    expect(writes[0]?.command.lsid).toEqual(writes[1]?.command.lsid);
    expect(writes[0]?.command.txnNumber).toEqual(writes[1]?.command.txnNumber);
    expect(new Set(writes.map(event => event.address))).toEqual(new Set([`127.0.0.1:${relay.port}`]));
    await client.db('test').collection('stepdown').findOne({});
  } finally {
    await client.close();
    await relay.close();
  }
}, 60_000);

it('does not report a connection ready after its generation was invalidated during handshake', async () => {
  const relay = await startRelay(targetPort);
  relay.pause();

  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${relay.port}`, {
    directConnection: true, serverSelectionTimeoutMS: 1000
  }));

  let ready = 0;
  client.on('connectionReady', () => ready++);

  try {
    const connecting = expect(client.connect()).rejects.toMatchObject({
      name: 'MongoPoolClearedError', errorLabels: expect.arrayContaining(['PoolRequestedRetry'])
    });

    await expect.poll(() => relay.counts.accepted).toBe(1);
    // SAFETY: connecting has created the topology and its pool before the relay accepts a socket.
    const native = client as MongoClient & { topology: import('../../src/no-monitoring/adapter.js').Topology };
    const server = native.topology.s.servers.values().next().value;

    if (!server) throw new Error('Missing server');
    server.pool.clear();
    server.pool.ready();
    relay.resume();
    await connecting;
    expect(ready).toBe(0);
  } finally {
    await client.close();
    await relay.close();
  }
});

it('ends sessions on an existing healthy connection during close', async () => {
  const client = disableMonitoring(new MongoClient(`mongodb://127.0.0.1:${targetPort}`, {
    directConnection: true, monitorCommands: true
  }));

  const commands: string[] = [];
  client.on('commandStarted', event => commands.push(event.commandName));

  try {
    await client.db('admin').command({ ping: 1 });
  } finally {
    await client.close();
  }

  expect(commands).toContain('endSessions');
});
