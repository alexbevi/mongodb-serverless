import { ConnectionString } from 'mongodb-connection-string-url';
import { setTimeout as delay } from 'node:timers/promises';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import { ServerlessDriverError } from './errors.js';
import { uncachedTopology, type TopologyPlugin } from './plugin.js';
import { parseTopology, type Topology } from './topology.js';
import { discoverTopology, openDiscovery, openSeed, readTopology } from './discovery.js';
import { directUri } from './uri.js';
import { observeMember, type MemberConnection } from './member.js';

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
 * Reads prefer a connected healthy secondary and fall back to the primary, which
 * is what a single-node set needs. When both resolve to the same host, one
 * client serves both.
 */
export class ClientPair {
  readonly #options: ClientPairOptions;
  readonly #clients = new Map<string, Promise<MemberConnection>>();
  #topology: Promise<Topology> | undefined;
  #bootstrap: Promise<MemberConnection> | undefined;
  #topologyFailed = false;
  #closed = false;
  #refresh: Promise<void> | undefined;
  #generation = 0;

  constructor(options: ClientPairOptions) {
    this.#options = options;
  }

  /** The client for operations that must reach the primary. */
  async write(): Promise<MongoClient> {
    return this.#selectMember('write');
  }

  /** The client for reads, targeting a secondary when one is healthy. */
  async read(anyMember = false): Promise<MongoClient> {
    return this.#selectMember(anyMember ? 'any' : 'read');
  }

  async #selectMember(route: 'read' | 'write' | 'any', refreshed = false): Promise<MongoClient> {
    this.#assertOpen();

    if (this.#topologyFailed) {
      this.#topology = undefined;
      this.#topologyFailed = false;
    }

    if (this.#options.plugin === uncachedTopology && !this.#topology) {
      const member = await this.#connectBootstrap();
      this.#assertOpen();

      const suitable = route === 'any'
        ? ['RSPrimary', 'RSSecondary'].includes(member.type)
        : member.type === (route === 'write' ? 'RSPrimary' : 'RSSecondary');

      if (suitable) return member.client;
    }

    const topology = await this.#resolveTopology();
    const generation = this.#generation;
    const secondary = topology.secondaries.find(host => this.#clients.has(host)) ?? topology.secondaries[0];

    const connected = route === 'any'
      ? [...this.#clients.keys()].find(host => host === topology.primary || topology.secondaries.includes(host))
      : undefined;

    const host = route === 'write' ? topology.primary : connected ?? secondary ?? topology.primary;
    const expected = host === topology.primary ? 'RSPrimary' : 'RSSecondary';
    const member = await this.#clientFor(host, topology);
    this.#assertOpen();

    if (member.type === expected) return member.client;

    if (refreshed) {
      throw new ServerlessDriverError(
        `Member "${host}" reports ${member.type}, but refreshed topology expects ${expected}.`
      );
    }

    await this.refreshTopology(generation);

    return this.#selectMember(route, true);
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      // Discovery must settle before a Lambda can freeze this client. It cannot undo an executed operation.
      if (this.#bootstrap) await this.#resolveTopology().catch(() => {});
    }
  }

  async #connectBootstrap(): Promise<MemberConnection> {
    this.#bootstrap ??= openSeed(
      this.#options.uri, this.#options.createClient, this.#options.driverOptions, this.#options.disableMonitoring
    ).then(async member => {
      if (this.#closed) {
        await member.client.close();
        this.#assertOpen();
      }

      if (member.host) this.#clients.set(member.host, Promise.resolve(member));

      return member;
    }).catch(error => {
      this.#bootstrap = undefined;
      throw error;
    });

    return this.#bootstrap;
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
      const known = this.#topologyFailed ? undefined : await this.#topology;

      const seeds = known ? [known.primary, ...known.secondaries] : undefined;

      const status = await discoverTopology(
        this.#options.uri, this.#options.createClient, this.#connectionOptions(known), seeds, this.#options.disableMonitoring
      );

      this.#assertOpen();
      await this.#options.plugin.write(status);
      this.#topology = Promise.resolve(parseTopology(status));
      this.#topologyFailed = false;
      this.#generation += 1;
    })().finally(() => { this.#refresh = undefined; });

    return this.#refresh;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([this.#bootstrap, this.#topology, this.#refresh]);
    const pending = [...this.#clients.values()];
    this.#clients.clear();
    this.#topology = undefined;

    await Promise.allSettled(
      pending.map(async client => {
        await (await client).client.close().catch(() => {});
      })
    );
  }

  /** Read once and reuse, but never cache a failure. */
  async #resolveTopology(): Promise<Topology> {
    this.#assertOpen();

    this.#topology ??= (async () => {
      if (this.#options.plugin === uncachedTopology) {
        const member = await this.#connectBootstrap();
        this.#assertOpen();

        return parseTopology(await readTopology(member));
      }

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
          this.#clients.set(host, Promise.resolve(discovered));
          retained = true;
        }

        return topology;
      } finally {
        if (!retained) await discovered.client.close().catch(() => {});
      }
    })().catch(
      error => {
        this.#topologyFailed = true;
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
  async #clientFor(hostPort: string, topology: Topology): Promise<MemberConnection> {
    this.#assertOpen();

    const existing = this.#clients.get(hostPort);

    if (existing != null) return existing;

    const options = this.#connectionOptions(topology);
    const uri = directUri(this.#options.uri, hostPort, options);

    // Memoise the promise, not the client, so concurrent callers share one
    // connect() instead of racing to create a second client.
    const pending = (async () => {
      const client = this.#options.createClient(uri, { ...options, directConnection: true, retryWrites: false });

      try {
        const member = observeMember(client);

        if (this.#options.disableMonitoring) {
          const { disableMonitoring } = await import('./no-monitoring/index.js');
          disableMonitoring(client);
        }

        await client.connect();

        return member;
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
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
    delete options.srvServiceName;
    delete options.srvMaxHosts;
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
