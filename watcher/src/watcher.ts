import type { MongoClientOptions } from 'mongodb';
import {
  resolvePlugin,
  type PluginSource,
  type ReplSetGetStatus,
  type TopologyPlugin
} from '../../plugins/shared/src/index.js';
import { ClusterConnection, type ClientFactory } from './cluster.js';

export interface WatcherOptions {
  /** Connection string for the cluster to watch. */
  uri: string;
  /** A plugin, or the name of a package exporting one. */
  plugin?: PluginSource;
  /** Builds the real client. For tests. */
  createClient?: ClientFactory;
  driverOptions?: MongoClientOptions;
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

  constructor(options: WatcherOptions) {
    this.#options = options;
    this.#connection = new ClusterConnection({
      uri: options.uri,
      ...(options.createClient ? { createClient: options.createClient } : {}),
      ...(options.driverOptions ? { driverOptions: options.driverOptions } : {})
    });
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
    const status = (await this.#connection.status()) as unknown as ReplSetGetStatus;

    await plugin.write(status);

    return {
      setName: identity.setName,
      members: Array.isArray(status.members) ? status.members.length : 0
    };
  }

  async close(): Promise<void> {
    await this.#connection.close();
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
