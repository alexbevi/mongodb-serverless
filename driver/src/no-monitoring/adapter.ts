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
}

import { EventEmitter } from 'node:events';
import type { Document, MongoClient } from 'mongodb';

export interface ApplicationConnection extends EventEmitter {
  hello: Document;
  generation: number;
  destroy(): void;
}

export interface Pool {
  poolState: string;
  generation: number;
  cancellationToken: EventEmitter;
  connections: { push(connection: ApplicationConnection): void };
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

export interface Monitor {
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
}

export const connectModule: {
  connect(options: ConnectionOptions): Promise<ApplicationConnection>;
} = requireMongo('./cmap/connect.js');
