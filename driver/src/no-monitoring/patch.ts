import { UnsupportedOperationError } from '../errors.js';
import type { MongoClient } from 'mongodb';
import { MongoClientClosedError } from 'mongodb';
import { connectModule, descriptionModule, monitorModule, topologyModule, registryKey, type Registry, type Server } from './adapter.js';

function bootstrap(server: Server, state: Registry): Promise<void> {
  const { pending, pools } = state;
  const existing = pending.get(server);

  if (existing) return existing;

  const pool = server.pool;

  if (pool.poolState === 'ready') pool.clear();
  pool.connections.prune(connection => pool.destroyConnectionIfPerished(connection));
  const generation = pool.generation;
  pools.set(pool.cancellationToken, server);

  const operation = new Promise<void>((resolve, reject) => {
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
  }).finally(() => pending.delete(server));

  pending.set(server, operation);

  return operation;
}

export function activate(client: MongoClient): void {
  const monitor = monitorModule.Monitor.prototype;

  const state = monitor[registryKey] ??= {
    enabled: new WeakSet<MongoClient>(),
    pending: new WeakMap<Server, Promise<void>>(),
    pools: new WeakMap(),
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
  const originalCreate = connectModule.connect;
  connectModule.connect = async function (options) {
    const connection = await originalCreate(options);
    const server = pools.get(options.cancellationToken);

    if (!server) return connection;

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
    const selection = originalSelect.call(this, selector, options);

    if (!server || (server.description.type !== 'Unknown' && server.pool.poolState === 'ready')) {
      return selection;
    }

    return Promise.race([selection, bootstrap(server, state).then(() => selection)]);
  };
}
