import { MongoClient, type Db, type MongoClientOptions, type MongoClientEvents } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import type { ClientFactory } from './clients.js';
import { Connection, type ConnectionSettings } from './connection.js';
import { UnsupportedOperationError } from './errors.js';
import { createDbFacade } from './facade.js';
import { createWriteExecutor } from './recovery.js';
import type { PluginSource } from '../../plugins/shared/src/index.js';
import type { TopologyPlugin } from './plugin.js';

export interface ServerlessClientOptions extends MongoClientOptions {
  /** A plugin, or the name of a package exporting one. */
  plugin?: PluginSource;
  /** Disable SDAM monitoring for the underlying direct connections. Requires mongodb >=7.7.0 <8.0.0. */
  disableMonitoring?: boolean;
  /** Listeners attached to each native client before it connects. */
  on?: Partial<MongoClientEvents> & ThisType<MongoClient>;
  /** Builds the real clients. For tests. */
  createClient?: ClientFactory;
}

const defaultFactory: ClientFactory = (uri, options) => new MongoClient(uri, options);

/**
 * Stands in for `MongoClient`, routing each operation to a client connected
 * directly to the member that should serve it.
 *
 * Composed rather than extending `MongoClient`, whose constructor eagerly
 * parses options and builds internal state for a connection this class never
 * makes.
 */
export class ServerlessMongoClient {
  readonly #connection: Connection;
  #defaultDb: string | undefined;

  constructor(plugin: TopologyPlugin);
  constructor(options: ServerlessClientOptions);
  constructor(uri: string, options?: ServerlessClientOptions);
  constructor();
  constructor(uriPluginOrOptions?: string | TopologyPlugin | ServerlessClientOptions, options: ServerlessClientOptions = {}) {
    this.#connection = new Connection(settingsFrom(uriPluginOrOptions, options));
  }

  get options(): Readonly<MongoClientOptions> {
    return Object.freeze({});
  }

  /** The plugin, once resolved, or undefined when none is configured. Resolution is deferred to first use. */
  async plugin(): Promise<TopologyPlugin | undefined> {
    return this.#connection.plugin();
  }

  /** Resolves the plugin and connection string, so configuration errors surface early. Opens no connection. */
  async connect(): Promise<this> {
    await this.#connection.clients();

    return this;
  }

  db(name?: string): Db {
    const uri = this.#connection.uri;
    const dbName = name ?? (this.#defaultDb ??= uri == null ? undefined : defaultDatabaseOf(uri));

    if (dbName == null) {
      throw new TypeError(
        'No database name given and the connection string has no default database.'
      );
    }

    return createDbFacade(
      {
        read: async anyMember => (await this.#connection.clients()).read(anyMember),
        write: async () => (await this.#connection.clients()).write()
      },
      dbName,
      createWriteExecutor(() => this.#connection.clients())
    );
  }

  /** Closes the connections this client opened. An unused client has nothing to close. */
  async close(): Promise<void> {
    await this.#connection.close();
  }

  watch(): never {
    throw new UnsupportedOperationError(
      'watch() is not supported. Change streams require resumable cursors across member changes.'
    );
  }

  startSession(): never {
    throw new UnsupportedOperationError(
      'startSession() is not supported. A session cannot span the read and write clients, ' +
        'because the driver requires it to come from the same MongoClient.'
    );
  }

  withSession(): never {
    this.startSession();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  toString(): string {
    return `ServerlessMongoClient(${this.#connection.uri})`;
  }
}

/** Reduces the four constructor forms to one set of connection settings. */
function settingsFrom(
  uriPluginOrOptions: string | TopologyPlugin | ServerlessClientOptions | undefined,
  options: ServerlessClientOptions
): ConnectionSettings {
  if (isPluginArgument(uriPluginOrOptions)) return settings(undefined, { plugin: uriPluginOrOptions });

  if (isClientOptions(uriPluginOrOptions)) return settings(undefined, uriPluginOrOptions);

  return settings(uriPluginOrOptions, options);
}

function settings(uri: string | undefined, options: ServerlessClientOptions): ConnectionSettings {
  const { plugin, createClient = defaultFactory, on = {}, disableMonitoring = false, ...driverOptions } = options;

  return { uri, plugin, createClient: withListeners(createClient, on), driverOptions, disableMonitoring };
}

/** Attaches the caller's event listeners to every native client before it connects. */
function withListeners(createClient: ClientFactory, on: NonNullable<ServerlessClientOptions['on']>): ClientFactory {
  return (uri, options) => {
    const client = createClient(uri, options);

    for (const [event, listener] of Object.entries(on)) {
      if (listener) client.on(event, listener);
    }

    return client;
  };
}

function defaultDatabaseOf(uri: string): string | undefined {
  try {
    const path = new ConnectionString(uri).pathname.replace(/^\//, '');

    return path === '' ? undefined : decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

function isPluginArgument(
  value: string | TopologyPlugin | ServerlessClientOptions | undefined
): value is TopologyPlugin {
  return typeof value === 'object' && value !== null &&
    'setup' in value &&
    'verify' in value &&
    'read' in value &&
    'write' in value;
}

function isClientOptions(
  value: string | ServerlessClientOptions | undefined
): value is ServerlessClientOptions {
  return typeof value === 'object' && value !== null;
}
