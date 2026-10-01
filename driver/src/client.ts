import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import { ClientPair, type ClientFactory } from './clients.js';
import { UnsupportedOperationError } from './errors.js';
import { createDbFacade } from './facade.js';
import { resolvePlugin, type PluginSource } from '../../plugins/shared/src/index.js';
import type { TopologyPlugin } from './plugin.js';

export interface ServerlessClientOptions extends MongoClientOptions {
  /** A plugin, or the name of a package exporting one. */
  plugin?: PluginSource;
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
  readonly #uri: string;
  readonly #defaultDb: string | undefined;
  readonly #plugin: Promise<TopologyPlugin>;
  readonly #pair: Promise<ClientPair>;

  constructor(uri: string, options: ServerlessClientOptions = {}) {
    const { plugin, createClient, ...driverOptions } = options;

    this.#uri = uri;
    this.#defaultDb = defaultDatabaseOf(uri);
    this.#plugin = resolvePlugin(plugin);
    this.#pair = this.#plugin.then(
      resolved =>
        new ClientPair({
          uri,
          plugin: resolved,
          createClient: createClient ?? defaultFactory,
          driverOptions
        })
    );
  }

  get options(): Readonly<MongoClientOptions> {
    return Object.freeze({});
  }

  /** The plugin, once resolved. Resolution is deferred to first use. */
  async plugin(): Promise<TopologyPlugin> {
    return this.#plugin;
  }

  /**
   * Present for drop-in compatibility. Real connections open on first
   * operation, so there is nothing to do here.
   */
  async connect(): Promise<this> {
    await this.#plugin;
    return this;
  }

  db(name?: string): Db {
    const dbName = name ?? this.#defaultDb;

    if (dbName == null) {
      throw new TypeError(
        'No database name given and the connection string has no default database.'
      );
    }

    return createDbFacade(
      {
        read: async () => (await this.#pair).read(),
        write: async () => (await this.#pair).write()
      },
      dbName
    );
  }

  async close(): Promise<void> {
    await (await this.#pair).close();
  }

  watch(): never {
    throw new UnsupportedOperationError(
      'watch() is not supported. Change streams need a resume story that belongs with ' +
        'the watcher, so they are out of scope in this version.'
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
    return `ServerlessMongoClient(${this.#uri})`;
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
