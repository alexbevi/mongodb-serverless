import { MongoClient, type Db, type MongoClientOptions, type MongoClientEvents } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import { ClientPair, type ClientFactory } from './clients.js';
import { ServerlessDriverError, UnsupportedOperationError } from './errors.js';
import { createDbFacade } from './facade.js';
import { createWriteExecutor } from './recovery.js';
import { resolvePlugin, type PluginSource } from '../../plugins/shared/src/index.js';
import { uncachedTopology, type TopologyPlugin } from './plugin.js';

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
  readonly #uri: string | undefined;
  #defaultDb: string | undefined;
  readonly #plugin: () => Promise<TopologyPlugin>;
  readonly #pair: () => Promise<ClientPair>;

  constructor(uri?: string, options: ServerlessClientOptions = {}) {
    const { plugin, createClient, on = {}, disableMonitoring = false, ...driverOptions } = options;

    this.#uri = uri;
    let resolvedPlugin: Promise<TopologyPlugin> | undefined;
    let pair: Promise<ClientPair> | undefined;
    this.#plugin = () => resolvedPlugin ??= resolvePlugin(plugin, uri == null ? undefined : uncachedTopology);
    this.#pair = () => pair ??= this.#plugin().then(
      async resolved => {
        const connectionString = uri ?? await resolved.getConnectionString?.();

        if (!connectionString) {
          throw new ServerlessDriverError('Supply a connection string or a plugin with getConnectionString().');
        }

        return new ClientPair({
          uri: connectionString,
          plugin: resolved,
          createClient: (uri, options) => {
            const client = (createClient ?? defaultFactory)(uri, options);

            for (const [event, listener] of Object.entries(on)) {
              if (listener) client.on(event, listener);
            }

            return client;
          },
          driverOptions,
          disableMonitoring
        });
      }
    ).catch(error => {
      pair = undefined;
      throw error;
    });
  }

  get options(): Readonly<MongoClientOptions> {
    return Object.freeze({});
  }

  /** The plugin, once resolved. Resolution is deferred to first use. */
  async plugin(): Promise<TopologyPlugin> {
    return this.#plugin();
  }

  /**
   * Present for drop-in compatibility. Real connections open on first
   * operation, so there is nothing to do here.
   */
  async connect(): Promise<this> {
    await this.#pair();

    return this;
  }

  db(name?: string): Db {
    const dbName = name ?? (this.#defaultDb ??= this.#uri == null ? undefined : defaultDatabaseOf(this.#uri));

    if (dbName == null) {
      throw new TypeError(
        'No database name given and the connection string has no default database.'
      );
    }

    return createDbFacade(
      {
        read: async anyMember => (await this.#pair()).read(anyMember),
        write: async () => (await this.#pair()).write()
      },
      dbName,
      createWriteExecutor(this.#pair)
    );
  }

  async close(): Promise<void> {
    await (await this.#pair()).close();
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
