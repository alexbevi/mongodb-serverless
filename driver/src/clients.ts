import { ConnectionString } from 'mongodb-connection-string-url';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import { Connector, readTopology, type ClientFactory } from './connector.js';
import { ServerlessDriverError } from './errors.js';
import type { MemberConnection } from './member.js';
import type { ReplSetGetStatus, TopologyPlugin } from './plugin.js';
import { chooseHost, serves, type Route } from './selection.js';
import { parseTopology, type Topology } from './topology.js';

export type { ClientFactory } from './connector.js';

export interface ClientPairOptions {
  uri: string;
  /** Shares topology between clients. Without one, topology is discovered and kept in memory. */
  plugin?: TopologyPlugin | undefined;
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
  readonly #connector: Connector;
  readonly #clients = new Map<string, Promise<MemberConnection>>();
  #parsedUri: ConnectionString | undefined;
  #topology: Promise<Topology> | undefined;
  #bootstrap: Promise<MemberConnection> | undefined;
  #refresh: Promise<void> | undefined;
  #generation = 0;
  #closed = false;

  constructor(options: ClientPairOptions) {
    this.#options = options;
    this.#connector = new Connector({ uri: options.uri, createClient: options.createClient, disableMonitoring: options.disableMonitoring });
  }

  /** The client for operations that must reach the primary. */
  async write(): Promise<MongoClient> {
    return this.#select('write');
  }

  /** The client for reads, targeting a secondary when one is healthy. */
  async read(anyMember = false): Promise<MongoClient> {
    return this.#select(anyMember ? 'any' : 'read');
  }

  get generation(): number {
    return this.#generation;
  }

  /** Rediscovers topology through the known members, once per generation however many callers ask. */
  async refreshTopology(generation: number): Promise<void> {
    this.#assertOpen();

    if (generation !== this.#generation) return;

    this.#refresh ??= (async () => {
      const known = await this.#topology?.catch(() => undefined);
      const seeds = known ? [known.primary, ...known.secondaries] : undefined;
      const discovered = await this.#connector.discover({ options: this.#connectionOptions(known), seeds });
      this.#topology = Promise.resolve(await this.#adopt(discovered.status, discovered, false));
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

  async #select(route: Route): Promise<MongoClient> {
    this.#assertOpen();

    // Without a plugin, the first connection may already be able to serve the operation.
    if (!this.#options.plugin && !this.#topology) {
      const member = await this.#connectBootstrap();
      this.#assertOpen();

      if (serves(route, member.type)) return member.client;
    }

    // A member whose reported role disagrees with the topology triggers one refresh.
    for (let attempt = 0; ; attempt++) {
      const topology = await this.#resolveTopology();
      const generation = this.#generation;
      const host = chooseHost(route, topology, this.#clients.keys());
      const expected = host === topology.primary ? 'RSPrimary' : 'RSSecondary';
      const member = await this.#clientFor(host, topology);
      this.#assertOpen();

      if (member.type === expected) return member.client;

      if (attempt > 0) {
        throw new ServerlessDriverError(`Member "${host}" reports ${member.type}, but refreshed topology expects ${expected}.`);
      }

      await this.refreshTopology(generation);
    }
  }

  async #connectBootstrap(): Promise<MemberConnection> {
    this.#bootstrap ??= this.#connector.seed({ options: this.#options.driverOptions }).then(async member => {
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

  /** Loads topology once and shares it; a failure is not cached, so the next call tries again. */
  async #resolveTopology(): Promise<Topology> {
    this.#assertOpen();

    if (!this.#topology) {
      const pending = this.#loadTopology();
      this.#topology = pending;
      pending.catch(() => {
        if (this.#topology === pending) this.#topology = undefined;
      });
    }

    return this.#topology;
  }

  async #loadTopology(): Promise<Topology> {
    const plugin = this.#options.plugin;

    if (!plugin) {
      // Read through the connection already open rather than opening another.
      const member = await this.#connectBootstrap();
      this.#assertOpen();

      return this.#adopt(await readTopology(member), undefined, false);
    }

    const status = await plugin.read();
    this.#assertOpen();

    if (status != null) {
      const topology = parseTopology(status);

      if (!topology.authentication || topology.authentication.mechanism === this.#authenticationMechanism()) {
        return topology;
      }
    }

    await plugin.setup();
    this.#assertOpen();
    const discovered = await this.#connector.discover({ options: this.#options.driverOptions });

    return this.#adopt(discovered.status, discovered, true);
  }

  /**
   * Persists discovered topology, then keeps the discovery connection if it can
   * serve later operations and closes it otherwise.
   */
  async #adopt(status: ReplSetGetStatus, connection: MemberConnection | undefined, retain: boolean): Promise<Topology> {
    let retained = false;

    try {
      this.#assertOpen();
      await this.#options.plugin?.write(status);
      this.#assertOpen();
      const topology = parseTopology(status);
      const host = connection?.host;

      if (retain && connection?.client.options.directConnection && host &&
          (host === topology.primary || topology.secondaries.includes(host))) {
        this.#clients.set(host, Promise.resolve(connection));
        retained = true;
      }

      return topology;
    } finally {
      if (connection && !retained) await connection.client.close().catch(() => {});
    }
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

    // Memoise the promise, not the client, so concurrent callers share one
    // connect() instead of racing to create a second client.
    const pending = this.#connector.member(hostPort, this.#connectionOptions(topology)).catch(error => {
      this.#clients.delete(hostPort);
      throw error;
    });

    this.#clients.set(hostPort, pending);

    return pending;
  }

  get #uri(): ConnectionString {
    return this.#parsedUri ??= new ConnectionString(this.#options.uri);
  }

  #authenticationMechanism(): string {
    return (this.#options.driverOptions?.authMechanism ?? this.#uri.searchParams.get('authMechanism') ?? 'DEFAULT').toUpperCase();
  }

  #connectionOptions(topology: Topology | undefined): MongoClientOptions {
    const options = { ...this.#options.driverOptions };
    delete options.srvServiceName;
    delete options.srvMaxHosts;

    if (topology?.authentication?.mechanism === this.#authenticationMechanism() &&
        options.authSource == null && !this.#uri.searchParams.has('authSource')) {
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
