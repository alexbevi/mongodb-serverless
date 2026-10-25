import type { Db, MongoClientOptions } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import { Connection, ConnectionSettings, type ServerlessClientOptions } from './connection.js';
import { UnsupportedOperationError } from './errors.js';
import { createDbFacade } from './facade.js';
import { createWriteExecutor } from './recovery.js';
import type { PluginSource } from '../../plugins/shared/src/index.js';
import type { TopologyPlugin } from './plugin.js';

export type { ServerlessClientOptions } from './connection.js';

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

  /** Drop-in for MongoClient: a connection string, optionally with a plugin to share topology. */
  constructor(uri: string, options?: ServerlessClientOptions);
  /** @internal Used by fromPlugin; ConnectionSettings is not part of the public API. */
  constructor(settings: ConnectionSettings);
  constructor(uriOrSettings: string | ConnectionSettings, options: ServerlessClientOptions = {}) {
    // ConnectionSettings only comes from this package's own factories, so instanceof is reliable here.
    const settings = uriOrSettings instanceof ConnectionSettings ? uriOrSettings : ConnectionSettings.fromUri(uriOrSettings, options);
    this.#connection = new Connection(settings);
  }

  /** A client whose plugin supplies the connection string, fetched when it first connects. */
  static fromPlugin(plugin: PluginSource, options?: Omit<ServerlessClientOptions, 'plugin'>): ServerlessMongoClient {
    return new ServerlessMongoClient(ConnectionSettings.fromPlugin(plugin, options));
  }

  get options(): Readonly<MongoClientOptions> {
    return Object.freeze({});
  }

  /** The plugin, once resolved, or undefined when none is configured. Resolution is deferred to first use. */
  async plugin(): Promise<TopologyPlugin | undefined> {
    return this.#connection.settings.plugin();
  }

  /** Resolves the plugin and connection string, so configuration errors surface early. Opens no connection. */
  async connect(): Promise<this> {
    await this.#connection.clients();

    return this;
  }

  db(name?: string): Db {
    const uri = this.#connection.settings.knownUri;
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
    return `ServerlessMongoClient(${this.#connection.settings.knownUri ?? 'plugin'})`;
  }
}

function defaultDatabaseOf(uri: string): string | undefined {
  try {
    const path = new ConnectionString(uri).pathname.replace(/^\//, '');

    return path === '' ? undefined : decodeURIComponent(path);
  } catch {
    return undefined;
  }
}
