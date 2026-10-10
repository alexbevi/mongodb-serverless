import { createRequire } from 'node:module';
import { UnsupportedOperationError } from '../errors.js';

export const requireMongo = createRequire(createRequire(import.meta.url).resolve('mongodb'));

export function assertVersion(version: string): void {
  if (version !== '7.7.0') {
    throw new UnsupportedOperationError(`disableMonitoring requires mongodb 7.7.0, found ${version}`);
  }
}

export function verifyDriver(): void {
  const manifest: { version: string } = requireMongo('../package.json');
  assertVersion(manifest.version);

  const methods = [connectModule.connect, connectModule.makeSocket, connectModule.makeConnection,
    connectModule.performInitialHandshake, monitorModule.Monitor.prototype.connect,
    topologyModule.Topology.prototype.selectServer, descriptionModule.ServerDescription,
    clientModule.MongoClient.prototype.close, poolModule.ConnectionPool.prototype.createConnection,
    poolModule.ConnectionPool.prototype.destroyConnectionIfPerished];

  if (!methods.every(isCallable)) {
    throw new UnsupportedOperationError('Unsupported mongodb driver internals');
  }
}

import { EventEmitter } from 'node:events';
import type { Document, MongoClient } from 'mongodb';

export interface ApplicationConnection extends EventEmitter {
  hello: Document;
  generation: number;
  destroy(): void;
}

export interface Pool extends EventEmitter {
  options: { maxPoolSize: number; maxConnecting: number };
  pendingConnectionCount: number;
  poolState: string;
  generation: number;
  cancellationToken: EventEmitter;
  totalConnectionCount: number;
  clear(): void;
  ready(): void;
  destroyConnectionIfPerished(connection: ApplicationConnection): boolean;
  connections: {
    push(connection: ApplicationConnection): void;
    prune(predicate: (connection: ApplicationConnection) => boolean): void;
  };
  createConnection(callback: (error?: Error, connection?: ApplicationConnection) => void): void;
  destroyConnection(connection: ApplicationConnection, reason: string): void;
}

export interface Server extends EventEmitter {
  topology: Topology;
  pool: Pool;
  description: { type: string; address: string; setName: string | null };
  s: { state: string };
}

export interface SelectionOptions {
  signal?: AbortSignal;
}

export interface Topology {
  client: MongoClient;
  s: { servers: Map<string, Server> };
  selectServer(selector: never, options: SelectionOptions): Promise<Server>;
}

export const registryKey = Symbol.for('@mongodb-serverless/no-monitoring/7.7.0');

export interface Registry {
  enabled: WeakSet<MongoClient>;
  closing: WeakSet<MongoClient>;
  pending: WeakMap<Server, Promise<void>>;
  waiters: WeakMap<Promise<void>, number>;
  cancel: WeakMap<Promise<void>, () => void>;
  pools: WeakMap<EventEmitter, Server>;
  installed: boolean;
}

export interface Monitor {
  [registryKey]?: Registry;
  server: Server;
  connect(): void;
}

export const monitorModule: { Monitor: { prototype: Monitor } } = requireMongo('./sdam/monitor.js');

export const topologyModule: { Topology: { prototype: Topology } } = requireMongo('./sdam/topology.js');

export const descriptionModule: {
  ServerDescription: new (address: string, hello: Document) => Server['description'];
} = requireMongo('./sdam/server_description.js');

export interface ConnectionOptions {
  cancellationToken: EventEmitter;
  generation: number;
}

export const connectModule: {
  connect(options: ConnectionOptions): Promise<ApplicationConnection>;
  makeSocket(options: ConnectionOptions): Promise<import('node:net').Socket>;
  makeConnection(options: ConnectionOptions, socket: import('node:net').Socket): ApplicationConnection;
  performInitialHandshake(connection: ApplicationConnection, options: ConnectionOptions): Promise<void>;
} = requireMongo('./cmap/connect.js');

export const clientModule: { MongoClient: typeof import('mongodb').MongoClient } = requireMongo('./mongo_client.js');

const poolModule: { ConnectionPool: { prototype: Pool } } = requireMongo('./cmap/connection_pool.js');

function isCallable(value: unknown): value is (...args: never[]) => void {
  return typeof value === 'function';
}
