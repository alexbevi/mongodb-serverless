import { UnsupportedOperationError } from '../errors.js';
import type { MongoClient } from 'mongodb';
import { MongoClientClosedError } from 'mongodb';
import { descriptionModule, monitorModule, topologyModule, type Server } from './adapter.js';

const enabled = new WeakSet<MongoClient>();

const pending = new WeakMap<Server, Promise<void>>();

let installed = false;

function bootstrap(server: Server): Promise<void> {
  const existing = pending.get(server);

  if (existing) return existing;

  const pool = server.pool;
  const generation = pool.generation;

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
  if (enabled.has(client)) return;

  if (('topology' in client && client.topology) || ('connectionLock' in client && client.connectionLock)) {
    throw new UnsupportedOperationError('Call disableMonitoring before connecting');
  }

  enabled.add(client);

  if (installed) return;
  installed = true;
  const monitor = monitorModule.Monitor.prototype;
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

    return Promise.race([selection, bootstrap(server).then(() => selection)]);
  };
}
