import type { MongoClientOptions } from 'mongodb';
import { ClientPair, type ClientFactory } from './clients.js';
import { ServerlessDriverError } from './errors.js';
import { resolveOptionalPlugin, resolvePlugin, type PluginSource } from '../../plugins/shared/src/index.js';
import type { TopologyPlugin } from './plugin.js';

export interface ConnectionSettings {
  uri: string | undefined;
  plugin: PluginSource | undefined;
  createClient: ClientFactory;
  driverOptions: MongoClientOptions;
  disableMonitoring: boolean;
}

/**
 * Resolves the plugin and connection string on first use, then owns the client
 * pair until closed. Nothing is resolved or opened before something needs it.
 */
export class Connection {
  readonly uri: string | undefined;
  readonly #settings: ConnectionSettings;
  #plugin: Promise<TopologyPlugin | undefined> | undefined;
  #clients: Promise<ClientPair> | undefined;
  #closed = false;

  constructor(settings: ConnectionSettings) {
    this.#settings = settings;
    this.uri = settings.uri;
  }

  /** Without a connection string the plugin must supply one; with it, a plugin is optional. */
  plugin(): Promise<TopologyPlugin | undefined> {
    this.#plugin ??= this.uri == null ? resolvePlugin(this.#settings.plugin) : resolveOptionalPlugin(this.#settings.plugin);

    return this.#plugin;
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
    const plugin = await this.plugin();
    const uri = this.uri ?? await plugin?.getConnectionString?.();

    if (!uri) throw new ServerlessDriverError('Supply a connection string or a plugin with getConnectionString().');

    const { createClient, driverOptions, disableMonitoring } = this.#settings;

    return new ClientPair({ uri, plugin, createClient, driverOptions, disableMonitoring });
  }
}
