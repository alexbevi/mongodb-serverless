import type { MongoClient, MongoClientOptions } from 'mongodb';
import { ServerlessDriverError } from './errors.js';
import type { TopologyPlugin } from './plugin.js';
import { parseTopology, type Topology } from './topology.js';
import { directUri } from './uri.js';

/** Builds a real client. Injectable so tests observe the uri without connecting. */
export type ClientFactory = (uri: string, options?: MongoClientOptions) => MongoClient;

export interface ClientPairOptions {
  uri: string;
  plugin: TopologyPlugin;
  createClient: ClientFactory;
  driverOptions?: MongoClientOptions;
}

/**
 * The read and write clients, each connected directly to one member and built
 * on first use.
 *
 * Reads prefer the first healthy secondary and fall back to the primary, which
 * is what a single-node set needs. When both resolve to the same host, one
 * client serves both.
 */
export class ClientPair {
  readonly #options: ClientPairOptions;
  readonly #clients = new Map<string, MongoClient>();
  #topology: Promise<Topology> | undefined;
  #closed = false;

  constructor(options: ClientPairOptions) {
    this.#options = options;
  }

  /** The client for operations that must reach the primary. */
  async write(): Promise<MongoClient> {
    const { primary } = await this.#resolveTopology();
    return this.#clientFor(primary);
  }

  /** The client for reads, targeting a secondary when one is healthy. */
  async read(): Promise<MongoClient> {
    const topology = await this.#resolveTopology();
    return this.#clientFor(selectSecondary(topology) ?? topology.primary);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    this.#topology = undefined;

    await Promise.all(clients.map(client => client.close()));
  }

  /** Read once and reuse, but never cache a failure. */
  async #resolveTopology(): Promise<Topology> {
    this.#assertOpen();

    this.#topology ??= (async () => parseTopology(await this.#options.plugin.read()))().catch(
      error => {
        this.#topology = undefined;
        throw error;
      }
    );

    return this.#topology;
  }

  #clientFor(hostPort: string): MongoClient {
    this.#assertOpen();

    const existing = this.#clients.get(hostPort);

    if (existing != null) return existing;

    const uri = directUri(this.#options.uri, hostPort);
    const client = this.#options.createClient(uri, this.#options.driverOptions);
    this.#clients.set(hostPort, client);

    return client;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ServerlessDriverError('This client is closed; create a new one to reconnect.');
    }
  }
}

/** First healthy secondary, keeping the choice in one place. */
function selectSecondary(topology: Topology): string | undefined {
  return topology.secondaries[0];
}
