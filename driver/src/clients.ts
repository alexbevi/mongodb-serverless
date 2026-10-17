import { setTimeout as delay } from 'node:timers/promises';
import { isTopologyFailure, wasRejectedBeforeWrite } from './recovery.js';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import { ServerlessDriverError } from './errors.js';
import type { TopologyPlugin } from './plugin.js';
import { parseTopology, type Topology } from './topology.js';
import { resolveSeedOptions, resolveSeeds } from './seeds.js';
import { discoverTopology } from './discovery.js';
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
  #uri: string;
  #refresh: Promise<void> | undefined;
  #generation = 0;

  constructor(options: ClientPairOptions) {
    this.#options = options;
    this.#uri = options.uri;
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

  async executeWrite<T>(operation: () => Promise<T>, replay = true): Promise<T> {
    const generation = this.#generation;

    try {
      return await operation();
    } catch (error) {
      if (!isTopologyFailure(error)) throw error;

      try {
        await this.#refreshTopology(generation);
      } catch {
        // Preserve the write failure when recovery itself fails.
        throw error;
      }

      if (!replay || !wasRejectedBeforeWrite(error)) throw error;

      return operation();
    }
  }

  async #refreshTopology(generation: number): Promise<void> {
    this.#assertOpen();

    if (generation !== this.#generation) return;

    this.#refresh ??= (async () => {
      await delay(100 + Math.floor(Math.random() * 150));
      this.#assertOpen();
      const known = await this.#topology;

      const seeds = known
        ? { uri: this.#uri, hosts: [known.primary, ...known.secondaries] }
        : await resolveSeeds(this.#options.uri);

      const status = await discoverTopology(
        seeds.uri, this.#options.createClient, this.#options.driverOptions, seeds.hosts
      );

      this.#assertOpen();
      await this.#options.plugin.write(status);
      this.#uri = seeds.uri;
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
        this.#uri = await resolveSeedOptions(this.#options.uri);

        return parseTopology(status);
      }

      this.#uri = (await resolveSeeds(this.#options.uri)).uri;

      await this.#options.plugin.setup();
      this.#assertOpen();

      const discovered = await discoverTopology(
        this.#uri, this.#options.createClient, this.#options.driverOptions
      );

      this.#assertOpen();
      await this.#options.plugin.write(discovered);

      return parseTopology(discovered);
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
  async #clientFor(hostPort: string): Promise<MongoClient> {
    this.#assertOpen();

    const existing = this.#clients.get(hostPort);

    if (existing != null) return existing;

    const uri = directUri(this.#uri, hostPort);

    // Memoise the promise, not the client, so concurrent callers share one
    // connect() instead of racing to create a second client.
    const pending = (async () => {
      const client = this.#options.createClient(uri, { ...this.#options.driverOptions, directConnection: true, retryWrites: false });

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
