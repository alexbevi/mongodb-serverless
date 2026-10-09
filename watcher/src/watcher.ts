import type { MongoClientOptions } from 'mongodb';
import {
  DEFAULT_PLUGIN_CONFIG,
  resolvePlugin,
  type PluginSource,
  type TopologyPlugin
} from '../../plugins/shared/src/index.js';
import { refreshIntervalMS } from './interval.js';
import { ClusterConnection, type ClientFactory, type ClusterConnectionOptions } from './cluster.js';

export interface WatcherOptions {
  /** Connection string for the cluster to watch. */
  uri: string;
  /** A plugin, or the name of a package exporting one. */
  plugin?: PluginSource;
  /** Builds the real client. For tests. */
  createClient?: ClientFactory;
  driverOptions?: MongoClientOptions;
  /**
   * Called when a polled cycle fails. Without it a failure is swallowed, since
   * throwing from a timer would be an unhandled rejection.
   */
  onError?: (error: unknown) => void;
}

/** What one cycle recorded. */
export interface CheckResult {
  setName: string;
  /** How many members the stored document describes. */
  members: number;
}

/**
 * Keeps a cluster's topology current in a plugin's store.
 *
 * One cycle verifies the connection with `hello`, reads `replSetGetStatus`,
 * and writes it back. There is no diff: `date` and each member's `uptime`
 * change on every call, so a comparison would report a change every time.
 */
export class Watcher {
  readonly #options: WatcherOptions;
  readonly #connection: ClusterConnection;
  #plugin: Promise<TopologyPlugin> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(options: WatcherOptions) {
    this.#options = options;

    const connectionOptions: ClusterConnectionOptions = { uri: options.uri };

    if (options.createClient) connectionOptions.createClient = options.createClient;

    if (options.driverOptions) connectionOptions.driverOptions = options.driverOptions;

    this.#connection = new ClusterConnection(connectionOptions);
  }

  /**
   * Runs one cycle: verify, read, write.
   *
   * @throws {ClusterUnreachableError} The cluster could not be reached.
   * @throws {AuthenticationFailedError} The credentials were rejected.
   * @throws {NotAReplicaSetError} Reachable, but not a replica set.
   * @throws {MissingPluginError} No plugin was configured.
   * @throws {PluginReadOnlyError} The plugin was not made writable.
   */
  async check(): Promise<CheckResult> {
    const plugin = await this.#resolvePlugin();

    // hello first, so a bad connection string or a non-replica-set fails
    // before anything is written.
    const identity = await this.#connection.hello();
    const status = await this.#connection.status();

    await plugin.write(status);

    return {
      setName: identity.setName,
      members: Array.isArray(status.members) ? status.members.length : 0
    };
  }

  /**
   * Runs a cycle now, then every `refreshIntervalMS` from the plugin config.
   *
   * A failed cycle is reported through `onError` and the loop continues, since
   * a cluster blip should not stop the watcher permanently.
   */
  start(): void {
    if (this.#running) return;

    // Set before the first cycle is awaited, so a second start() during that
    // cycle cannot begin a parallel loop.
    this.#running = true;

    void (async () => {
      const intervalMS = await this.#intervalMS();
      await this.#cycle();

      // stop() during the first cycle leaves nothing to schedule.
      if (!this.#running) return;

      this.#timer = setInterval(() => void this.#cycle(), intervalMS);
      this.#timer.unref?.();
    })();
  }

  /** Stops polling and closes the connection. */
  async stop(): Promise<void> {
    this.#running = false;

    if (this.#timer != null) clearInterval(this.#timer);

    this.#timer = undefined;

    await this.close();
  }

  async close(): Promise<void> {
    await this.#connection.close();
  }

  /** One cycle that reports rather than throws, so a timer cannot reject. */
  async #cycle(): Promise<void> {
    try {
      await this.check();
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  /**
   * The poll period, from the plugin's config when it exposes one.
   *
   * A plugin only has to match the contract structurally, so `get` may be
   * absent; the contract's own default stands in.
   */
  async #intervalMS(): Promise<number> {
    try {
      const plugin = await this.#resolvePlugin();

      return refreshIntervalMS(plugin);
    } catch {
      // A plugin that cannot be resolved still fails loudly in the cycle.
      return DEFAULT_PLUGIN_CONFIG.refreshIntervalMS;
    }
  }

  /** Resolved once and reused, but a failure is not cached. */
  #resolvePlugin(): Promise<TopologyPlugin> {
    this.#plugin ??= resolvePlugin(this.#options.plugin).catch(error => {
      this.#plugin = undefined;
      throw error;
    });

    return this.#plugin;
  }
}
