import { ConnectionString } from 'mongodb-connection-string-url';
import { setTimeout as delay } from 'node:timers/promises';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import { ServerlessDriverError } from './errors.js';
import type { TopologyPlugin } from './plugin.js';
import { parseTopology, type Topology } from './topology.js';
import { discoverTopology, openDiscovery } from './discovery.js';
import { directUri } from './uri.js';

/** Builds a real client. Injectable so tests observe the uri without connecting. */
export type ClientFactory = (uri: string, options?: MongoClientOptions) => MongoClient;

export interface ClientPairOptions {
  uri: string;
  plugin: TopologyPlugin;
  createClient: ClientFactory;
  driverOptions?: MongoClientOptions;
  disableMonitoring?: boolean;
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
  #refresh: Promise<void> | undefined;
  #generation = 0;

  constructor(options: ClientPairOptions) {
    this.#options = options;
  }

  /** The client for operations that must reach the primary. */
  async write(): Promise<MongoClient> {
    const topology = await this.#resolveTopology();

    return this.#clientFor(topology.primary, topology);
  }

  /** The client for reads, targeting a secondary when one is healthy. */
  async read(): Promise<MongoClient> {
    const topology = await this.#resolveTopology();

    return this.#clientFor(selectSecondary(topology) ?? topology.primary, topology);
  }

  get generation(): number {
    return this.#generation;
  }

  async refreshTopology(generation: number): Promise<void> {
    this.#assertOpen();

    if (generation !== this.#generation) return;

    this.#refresh ??= (async () => {
      await delay(100 + Math.floor(Math.random() * 150));
      this.#assertOpen();
      const known = await this.#topology;

      const seeds = known ? [known.primary, ...known.secondaries] : undefined;

      const status = await discoverTopology(
        this.#options.uri, this.#options.createClient, this.#connectionOptions(known), seeds, this.#options.disableMonitoring
      );

      this.#assertOpen();
      await this.#options.plugin.write(status);
      this.#topology = Promise.resolve(parseTopology(status));
      this.#generation += 1;
    })().finally(() => { this.#refresh = undefined; });

    return this.#refresh;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([this.#topology, this.#refresh]);
    const pending = [...this.#clients.values()];
    this.#clients.clear();
    this.#topology = undefined;

    await Promise.allSettled(
      pending.map(async client => {
        await (await client).close().catch(() => {});
      })
    );
  }

  /** Read once and reuse, but never cache a failure. */
  async #resolveTopology(): Promise<Topology> {
    this.#assertOpen();

    this.#topology ??= (async () => {
      const status = await this.#options.plugin.read();
      this.#assertOpen();

      if (status != null) {
        const topology = parseTopology(status);

        if (!topology.authentication || topology.authentication.mechanism === this.#authenticationMechanism()) {
          return topology;
        }
      }

      await this.#options.plugin.setup();
      this.#assertOpen();

      const discovered = await openDiscovery(
        this.#options.uri, this.#options.createClient, this.#options.driverOptions,
        undefined, this.#options.disableMonitoring
      );

      let retained = false;

      try {
        this.#assertOpen();
        await this.#options.plugin.write(discovered.status);
        this.#assertOpen();
        const topology = parseTopology(discovered.status);
        const { host, client } = discovered;

        if (client.options.directConnection && host &&
            (host === topology.primary || topology.secondaries.includes(host))) {
          this.#clients.set(host, Promise.resolve(client));
          retained = true;
        }

        return topology;
      } finally {
        if (!retained) await discovered.client.close().catch(() => {});
      }
    })().catch(
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
  async #clientFor(hostPort: string, topology: Topology): Promise<MongoClient> {
    this.#assertOpen();

    const existing = this.#clients.get(hostPort);

    if (existing != null) return existing;

    const uri = directUri(this.#options.uri, hostPort);
    const options = this.#connectionOptions(topology);

    // Memoise the promise, not the client, so concurrent callers share one
    // connect() instead of racing to create a second client.
    const pending = (async () => {
      const client = this.#options.createClient(uri, { ...options, directConnection: true, retryWrites: false });

      try {
        if (this.#options.disableMonitoring) {
          const { disableMonitoring } = await import('./no-monitoring/index.js');
          disableMonitoring(client);
        }

        await client.connect();
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }

      return client;
    })().catch(error => {
      this.#clients.delete(hostPort);
      throw error;
    });

    this.#clients.set(hostPort, pending);

    return pending;
  }

  #authenticationMechanism(): string {
    const uri = new ConnectionString(this.#options.uri);

    return (this.#options.driverOptions?.authMechanism ?? uri.searchParams.get('authMechanism') ?? 'DEFAULT').toUpperCase();
  }

  #connectionOptions(topology: Topology | undefined): MongoClientOptions {
    const options = { ...this.#options.driverOptions };
    const uri = new ConnectionString(this.#options.uri);

    if (topology?.authentication?.mechanism === this.#authenticationMechanism() &&
        options.authSource == null && !uri.searchParams.has('authSource')) {
      options.authSource = topology.authentication.source;
    }

    return options;
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
