import { UnsupportedOperationError } from '../errors.js';
import type { MongoClient } from 'mongodb';
import { MongoClientClosedError } from 'mongodb';
import { clientModule, connectModule, descriptionModule, monitorModule, topologyModule, registryKey, type Registry, type Pool, type Server } from './adapter.js';

function bootstrap(server: Server, state: Registry): Promise<void> {
  const { pending, pools } = state;
  const existing = pending.get(server);

  if (existing) return existing;

  const pool = server.pool;

  if (pool.poolState === 'ready') pool.clear();
  pool.connections.prune(connection => pool.destroyConnectionIfPerished(connection));
  const generation = pool.generation;
  pools.set(pool.cancellationToken, server);

  const cancellation = new AbortController();

  const operation = waitForCapacity(pool, cancellation.signal).then(() => new Promise<void>((resolve, reject) => {
    if (pool.poolState === 'closed' || pool.generation !== generation) {
      reject(new MongoClientClosedError());

      return;
    }

    pool.poolState = 'ready';
    pool.createConnection((error, connection) => {
      if (error || !connection) {
        reject(error ?? new Error('Bootstrap returned no connection'));

        return;
      }

      if (pool.poolState === 'closed' || pool.generation !== generation) {
        pool.destroyConnection(connection, 'stale');
        reject(new MongoClientClosedError());

        return;
      }

      pool.connections.push(connection);
      pool.poolState = 'paused';
      server.emit('descriptionReceived', new descriptionModule.ServerDescription(
        server.description.address, connection.hello
      ));

      if (server.s.state === 'connecting') {
        server.emit('stateChanged', 'connecting', 'connected');
        server.s.state = 'connected';
        server.emit('connect', server);
      }

      resolve();
    });
  })).finally(() => {
    if (pending.get(server) === operation) pending.delete(server);
  });

  pending.set(server, operation);
  state.cancel.set(operation, () => {
    if (pending.get(server) !== operation) return;
    pending.delete(server);
    cancellation.abort();
    pool.clear();
    pool.cancellationToken.emit('cancel');
  });

  return operation;
}

function waitForCapacity(pool: Pool, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = ['connectionCheckedIn', 'connectionReady', 'connectionClosed', 'connectionPoolClosed'];

    const check = (): void => {
      if (!signal.aborted && pool.poolState !== 'closed' &&
        ((pool.options.maxPoolSize !== 0 && pool.totalConnectionCount >= pool.options.maxPoolSize) ||
          pool.pendingConnectionCount >= pool.options.maxConnecting)) return;

      for (const event of events) pool.removeListener(event, schedule);

      signal.removeEventListener('abort', schedule);

      if (signal.aborted || pool.poolState === 'closed') reject(new MongoClientClosedError());
      else resolve();
    };

    const schedule = (): void => queueMicrotask(check);

    signal.addEventListener('abort', schedule);

    for (const event of events) pool.on(event, schedule);
    check();
  });
}

export function activate(client: MongoClient): void {
  const monitor = monitorModule.Monitor.prototype;

  const state = monitor[registryKey] ??= {
    enabled: new WeakSet<MongoClient>(),
    closing: new WeakSet<MongoClient>(),
    pending: new WeakMap<Server, Promise<void>>(),
    pools: new WeakMap(),
    waiters: new WeakMap(),
    cancel: new WeakMap(),
    installed: false
  };

  const { enabled, pools } = state;

  if (enabled.has(client)) return;

  if (('topology' in client && client.topology) || ('connectionLock' in client && client.connectionLock)) {
    throw new UnsupportedOperationError('Call disableMonitoring before connecting');
  }

  enabled.add(client);

  if (state.installed) return;
  state.installed = true;
  const originalClose = clientModule.MongoClient.prototype.close;
  clientModule.MongoClient.prototype.close = function (...args) {
    if (enabled.has(this)) state.closing.add(this);

    return originalClose.apply(this, args);
  };

  const originalCreate = connectModule.connect;
  connectModule.connect = async function (options) {
    const server = pools.get(options.cancellationToken);

    if (server && state.closing.has(server.topology.client)) throw new MongoClientClosedError();

    if (!server) return originalCreate(options);

    const socket = await connectModule.makeSocket(options);

    if (server.pool.poolState === 'closed' || server.pool.generation !== options.generation) {
      socket.destroy();
      throw new MongoClientClosedError();
    }

    const connection = connectModule.makeConnection(options, socket);
    const cancel = (): void => connection.destroy();
    options.cancellationToken.on('cancel', cancel);

    try {
      await connectModule.performInitialHandshake(connection, options);
    } catch (cause) {
      connection.destroy();
      throw cause;
    } finally {
      options.cancellationToken.removeListener('cancel', cancel);
    }

    if (server.pool.poolState === 'closed' || server.pool.generation !== options.generation) {
      connection.destroy();
      throw new MongoClientClosedError();
    }

    const description = new descriptionModule.ServerDescription(server.description.address, connection.hello);

    if (!['RSPrimary', 'RSSecondary'].includes(description.type)) {
      connection.destroy();
      throw new UnsupportedOperationError('disableMonitoring requires a data-bearing replica set member');
    }

    const expectedSet = server.topology.client.options.replicaSet;

    if (expectedSet && description.setName !== expectedSet) {
      connection.destroy();
      throw new UnsupportedOperationError(`Expected replica set ${expectedSet}, received ${description.setName}`);
    }

    return connection;
  };

  const originalConnect = monitor.connect;
  monitor.connect = function () {
    if (!enabled.has(this.server.topology.client)) originalConnect.call(this);
  };

  const topology = topologyModule.Topology.prototype;
  const originalSelect = topology.selectServer;
  topology.selectServer = function (selector, options) {
    if (!enabled.has(this.client)) return originalSelect.call(this, selector, options);

    const server = this.s.servers.values().next().value;

    if (state.closing.has(this.client)) {
      if (server && server.description.type !== 'Unknown' && server.pool.poolState === 'ready') {
        return originalSelect.call(this, selector, options);
      }

      return Promise.reject(new MongoClientClosedError());
    }

    if (server && server.pool.poolState !== 'ready' && server.description.type !== 'Unknown') {
      server.emit('descriptionReceived', new descriptionModule.ServerDescription(server.description.address, {}));
    }

    const selection = originalSelect.call(this, selector, options);

    if (!server || (server.description.type !== 'Unknown' && server.pool.poolState === 'ready')) {
      return selection;
    }

    const operation = bootstrap(server, state);
    state.waiters.set(operation, (state.waiters.get(operation) ?? 0) + 1);

    return Promise.race([selection, operation.then(() => selection)]).finally(() => {
      const remaining = (state.waiters.get(operation) ?? 1) - 1;
      state.waiters.set(operation, remaining);

      if (remaining === 0) state.cancel.get(operation)?.();
    });
  };
}
