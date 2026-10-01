import { MongoClient, type MongoClientOptions } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import {
  AuthenticationFailedError,
  ClusterUnreachableError,
  NotAReplicaSetError
} from './errors.js';

/** Builds a real client. Injectable so tests need no server. */
export type ClientFactory = (uri: string, options?: MongoClientOptions) => MongoClient;

export interface ClusterConnectionOptions {
  uri: string;
  createClient?: ClientFactory;
  driverOptions?: MongoClientOptions;
}

/** What `hello` tells us about the cluster. */
export interface ClusterIdentity {
  setName: string;
  /** Members the cluster reports, which may lag its config. */
  hosts: string[];
  /** The member that answered. */
  me: string | undefined;
}

/** MongoDB's error code for rejected credentials. */
const AUTHENTICATION_FAILED = 18;

/** `replSetGetStatus` against a server started without `--replSet`. */
const NO_REPLICATION_ENABLED = 76;

const defaultFactory: ClientFactory = (uri, options) => new MongoClient(uri, options);

/**
 * One ordinary connection to a cluster, used to read its topology.
 *
 * No pool options are set. `minPoolSize` makes the driver open connections in
 * the background, which turns a rejected credential into a `PoolClearedError`
 * with the real cause buried underneath; left alone, the authentication error
 * arrives directly.
 */
export class ClusterConnection {
  readonly #options: ClusterConnectionOptions;
  #client: Promise<MongoClient> | undefined;

  constructor(options: ClusterConnectionOptions) {
    this.#options = options;
  }

  /**
   * Confirms the connection works and the cluster is a replica set.
   *
   * @throws {ClusterUnreachableError} The cluster could not be reached.
   * @throws {AuthenticationFailedError} The credentials were rejected.
   * @throws {NotAReplicaSetError} Reachable, but not a replica set.
   */
  async hello(): Promise<ClusterIdentity> {
    const hello = (await this.#command({ hello: 1 })) as Record<string, unknown>;

    if (hello['msg'] === 'isdbgrid') {
      throw new NotAReplicaSetError(
        `${this.#safeUri()} is a mongos, so its topology does not come from ` +
          'replSetGetStatus. Sharded clusters are not supported.'
      );
    }

    const setName = hello['setName'];

    if (typeof setName !== 'string' || setName === '') {
      throw new NotAReplicaSetError(
        `${this.#safeUri()} is not a replica set: hello reported no setName. ` +
          'A standalone server has no topology to watch.'
      );
    }

    return {
      setName,
      hosts: Array.isArray(hello['hosts']) ? (hello['hosts'] as string[]) : [],
      me: typeof hello['me'] === 'string' ? hello['me'] : undefined
    };
  }

  /** The cluster's `replSetGetStatus` document, returned unchanged. */
  async status(): Promise<Record<string, unknown>> {
    return (await this.#command({ replSetGetStatus: 1 })) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    const pending = this.#client;
    this.#client = undefined;

    if (pending == null) return;

    await (await pending).close().catch(() => {});
  }

  async #command(document: Record<string, unknown>): Promise<unknown> {
    try {
      const client = await this.#connect();
      return await client.db('admin').command(document);
    } catch (error) {
      throw this.#classify(error);
    }
  }

  #connect(): Promise<MongoClient> {
    this.#client ??= (async () => {
      const create = this.#options.createClient ?? defaultFactory;
      const client = create(this.#options.uri, this.#options.driverOptions);
      await client.connect();
      return client;
    })().catch(error => {
      // Not cached, so a transient failure does not disable this connection.
      this.#client = undefined;
      throw error;
    });

    return this.#client;
  }

  /** Turns a driver error into one that says what the operator should fix. */
  #classify(error: unknown): unknown {
    if (!(error instanceof Error)) return error;

    const code = (error as { code?: unknown }).code;

    if (code === AUTHENTICATION_FAILED) {
      return new AuthenticationFailedError(
        `Authentication failed for ${this.#safeUri()}. Check the credentials and authSource.`,
        { cause: error }
      );
    }

    if (code === NO_REPLICATION_ENABLED) {
      return new NotAReplicaSetError(
        `${this.#safeUri()} is not running with --replSet, so it has no topology to watch.`,
        { cause: error }
      );
    }

    if (error.name === 'MongoServerSelectionError' || error.name === 'MongoNetworkError') {
      return new ClusterUnreachableError(
        `Cannot reach ${this.#safeUri()}: ${error.message}`,
        { cause: error }
      );
    }

    return error;
  }

  /** The uri with any password removed, safe to put in an error message. */
  #safeUri(): string {
    try {
      const url = new ConnectionString(this.#options.uri);
      url.password = '';
      return url.hosts.join(',');
    } catch {
      return 'the cluster';
    }
  }
}
