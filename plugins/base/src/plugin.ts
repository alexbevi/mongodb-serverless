import type { ReplSetGetStatus } from './status.js';

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

  /** @param defaults Config keys a subclass adds on top of {@link PluginConfig}. */
  constructor(defaults?: Omit<C, keyof PluginConfig>) {
    if (new.target === ServerlessPlugin) {
      throw new TypeError('ServerlessPlugin is abstract and cannot be constructed directly');
    }

    this.#config = { ...DEFAULT_PLUGIN_CONFIG, ...defaults } as C;
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
