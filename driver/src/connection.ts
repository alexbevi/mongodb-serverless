import { MongoClient, type MongoClientEvents, type MongoClientOptions } from 'mongodb';
import { ClientPair, type ClientFactory } from './clients.js';
import { ServerlessDriverError } from './errors.js';
import { resolveOptionalPlugin, resolvePlugin, type PluginSource } from '../../plugins/shared/src/index.js';
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
 * What a client connects with: its plugin and connection string, both resolved
 * when first needed, and the options for every native client. Built only through
 * `fromUri` and `fromPlugin`; not part of the public API.
 */
export class ConnectionSettings {
  /** The connection string when given directly; a plugin's is not known until resolved. */
  readonly knownUri: string | undefined;
  readonly createClient: ClientFactory;
  readonly driverOptions: MongoClientOptions;
  readonly disableMonitoring: boolean;
  readonly #resolvePlugin: () => Promise<TopologyPlugin | undefined>;
  #plugin: Promise<TopologyPlugin | undefined> | undefined;
  #uri: Promise<string> | undefined;

  private constructor(knownUri: string | undefined, resolve: () => Promise<TopologyPlugin | undefined>, options: ServerlessClientOptions) {
    const { plugin: _plugin, createClient = defaultFactory, on = {}, disableMonitoring = false, ...driverOptions } = options;
    this.knownUri = knownUri;
    this.#resolvePlugin = resolve;
    this.createClient = withListeners(createClient, on);
    this.driverOptions = driverOptions;
    this.disableMonitoring = disableMonitoring;
  }

  /** A connection string, with an optional plugin to share topology between clients. */
  static fromUri(uri: string, options: ServerlessClientOptions = {}): ConnectionSettings {
    return new ConnectionSettings(uri, () => resolveOptionalPlugin(options.plugin), options);
  }

  /** A plugin that supplies the connection string, such as one reading a secret store. */
  static fromPlugin(plugin: PluginSource, options: Omit<ServerlessClientOptions, 'plugin'> = {}): ConnectionSettings {
    return new ConnectionSettings(undefined, () => resolvePlugin(plugin), options);
  }

  /**
   * The plugin, resolved once; undefined when a connection string was given without
   * one. A failed resolution is not kept, so the next call retries, as with `uri()`.
   */
  plugin(): Promise<TopologyPlugin | undefined> {
    this.#plugin ??= this.#resolvePlugin().catch(error => {
      this.#plugin = undefined;
      throw error;
    });

    return this.#plugin;
  }

  /** The connection string, resolved once. A failed lookup is not kept, so the next call retries. */
  uri(): Promise<string> {
    this.#uri ??= this.#lookUpUri().catch(error => {
      this.#uri = undefined;
      throw error;
    });

    return this.#uri;
  }

  async #lookUpUri(): Promise<string> {
    const uri = this.knownUri ?? await (await this.plugin())?.getConnectionString?.();

    if (!uri) throw new ServerlessDriverError('Supply a connection string or a plugin with getConnectionString().');

    return uri;
  }
}

/** Owns the client pair: opened on first use, closed with what it opened. */
export class Connection {
  readonly settings: ConnectionSettings;
  #clients: Promise<ClientPair> | undefined;
  #closed = false;

  constructor(settings: ConnectionSettings) {
    this.settings = settings;
  }

  /** The client pair, created once. A failed attempt is not kept, so the next call retries. */
  clients(): Promise<ClientPair> {
    if (this.#closed) return Promise.reject(new ServerlessDriverError('This client is closed; create a new one to reconnect.'));

    this.#clients ??= this.#open().catch(error => {
      this.#clients = undefined;
      throw error;
    });

    return this.#clients;
  }

  /** Closes what was opened. An unused connection has nothing to close and resolves nothing. */
  async close(): Promise<void> {
    this.#closed = true;
    const pending = this.#clients;
    this.#clients = undefined;

    // A lookup that failed opened nothing, so there is nothing to close.
    const opened = await pending?.catch(() => undefined);

    if (opened) await opened.close();
  }

  async #open(): Promise<ClientPair> {
    const { settings } = this;
    const uri = await settings.uri();

    return new ClientPair({ uri, plugin: await settings.plugin(), createClient: settings.createClient,
      driverOptions: settings.driverOptions, disableMonitoring: settings.disableMonitoring });
  }
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
