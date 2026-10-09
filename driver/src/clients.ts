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
  readonly #clients = new Map<string, Promise<MongoClient>>();
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
    const pending = [...this.#clients.values()];
    this.#clients.clear();
    this.#topology = undefined;

    // A client whose connect() failed has nothing to close, and its rejection
    // should not mask the close.
    await Promise.all(
      pending.map(async client => {
        await (await client).close().catch(() => {});
      })
    );
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

  /**
   * Builds and connects the client for one member, once.
   *
   * Connecting eagerly rather than letting the first operation do it: the
   * driver's bulk write builders read connection state at construction and
   * throw "MongoClient must be connected" if nothing has connected yet, so an
   * unconnected client breaks initializeOrderedBulkOp as a first operation.
   */
  async #clientFor(hostPort: string): Promise<MongoClient> {
    this.#assertOpen();

    const existing = this.#clients.get(hostPort);

    if (existing != null) return existing;

    const uri = directUri(this.#options.uri, hostPort);

    // Memoise the promise, not the client, so concurrent callers share one
    // connect() instead of racing to create a second client.
    const pending = (async () => {
      const client = this.#options.createClient(uri, this.#options.driverOptions);
      await client.connect();

      return client;
    })().catch(error => {
      this.#clients.delete(hostPort);
      throw error;
    });

    this.#clients.set(hostPort, pending);

    return pending;
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
