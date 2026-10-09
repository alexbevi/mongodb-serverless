import type { ReplSetGetStatus } from './status.js';
import { PluginReadOnlyError } from './errors.js';

/**
 * The shape a plugin must have, independent of how it was built.
 *
 * Consumers validate against this structurally, so a plugin satisfies it
 * without extending {@link ServerlessPlugin} or sharing a class.
 */
export interface TopologyPlugin {
  readonly name: string;
  readonly version: string;
  readonly author: string;

  setup(): Promise<void>;
  verify(): Promise<void>;
  read(): Promise<ReplSetGetStatus>;
  write(status: ReplSetGetStatus): Promise<void>;
}

export interface PluginConfig {
  /** How often the watcher refreshes stored topology. */
  refreshIntervalMS: number;
  /** Names where the topology document lives. Each plugin interprets it. */
  clusterTopologyVariableName: string;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  refreshIntervalMS: 10_000,
  clusterTopologyVariableName: '__MONGODB_CLUSTER_TOPOLOGY'
};

/**
 * The contract a topology source implements.
 *
 * Extending this is optional. The driver validates plugins structurally, so
 * any object of the same shape works. See the package README.
 */
export abstract class ServerlessPlugin<C extends PluginConfig = PluginConfig> {
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly author: string;

  readonly #config: C;
  readonly #writable: boolean;

  /**
   * @param options Config keys a subclass adds on top of {@link PluginConfig},
   * plus `writable` to permit writes.
   */
  constructor(options?: { writable?: boolean } & Omit<C, keyof PluginConfig>) {
    if (new.target === ServerlessPlugin) {
      throw new TypeError('ServerlessPlugin is abstract and cannot be constructed directly');
    }

    const { writable = false, ...defaults } = options ?? {};

    this.#writable = writable;
    // SAFETY: Subclasses supply C's added keys in options; the base keys come from DEFAULT_PLUGIN_CONFIG.
    this.#config = { ...DEFAULT_PLUGIN_CONFIG, ...defaults } as C;
  }

  /**
   * Whether this plugin may write to its store.
   *
   * Read-only unless asked for, so a consumer that only reads is safe without
   * doing anything. The watcher is the only writer.
   */
  get writable(): boolean {
    return this.#writable;
  }

  /** Call first from `write()`. Throws unless this plugin is writable. */
  protected assertWritable(): void {
    if (!this.#writable) {
      throw new PluginReadOnlyError(
        `Plugin "${this.name}" is read-only. Construct it with { writable: true } to ` +
          'write topology, which is the watcher\'s job rather than the driver\'s.'
      );
    }
  }

  /** Prepare the store holding the topology document. */
  abstract setup(): Promise<void>;

  /** Throw if the store is unusable, naming what is wrong. */
  abstract verify(): Promise<void>;

  abstract read(): Promise<ReplSetGetStatus>;

  abstract write(status: ReplSetGetStatus): Promise<void>;

  get<K extends keyof C>(key: K): C[K] {
    this.#assertKnown(key);

    return this.#config[key];
  }

  set<K extends keyof C>(key: K, value: C[K]): void {
    this.#assertKnown(key);
    this.#config[key] = value;
  }

  #assertKnown<K extends keyof C>(key: K): void {
    if (!Object.hasOwn(this.#config, key)) {
      const known = Object.keys(this.#config).sort().join(', ');
      throw new RangeError(`Unknown config key "${String(key)}". Known keys: ${known}`);
    }
  }
}
