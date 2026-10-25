import { ConnectionString } from 'mongodb-connection-string-url';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import { assertStatus } from '../../plugins/shared/src/index.js';
import { ServerlessDriverError } from './errors.js';
import { observeMember, type MemberConnection } from './member.js';
import type { ReplSetGetStatus } from './plugin.js';
import { resolveSeeds } from './seeds.js';
import { parseTopology } from './topology.js';
import { directUri } from './uri.js';

/** Builds a real client. Injectable so tests observe the uri without connecting. */
export type ClientFactory = (uri: string, options?: MongoClientOptions) => MongoClient;

export interface ConnectorSettings {
  /** The user's connection string, which every direct connection is derived from. */
  uri: string;
  createClient: ClientFactory;
  disableMonitoring?: boolean | undefined;
}

export interface SeedRequest {
  options?: MongoClientOptions | undefined;
  /** Members to try, as `host:port`. Without them, seeds come from the connection string. */
  seeds?: string[] | undefined;
}

export interface DiscoveryConnection extends MemberConnection {
  status: ReplSetGetStatus;
}

/** Opens direct connections to replica-set members. */
export class Connector {
  readonly #settings: ConnectorSettings;

  constructor(settings: ConnectorSettings) {
    this.#settings = settings;
  }

  get uri(): string {
    return this.#settings.uri;
  }

  /** Connects directly to one member. */
  member(hostPort: string, options: MongoClientOptions): Promise<MemberConnection> {
    return this.#open(directUri(this.#settings.uri, hostPort, options), { ...options, directConnection: true });
  }

  /** Connects to the first seed that answers as a member of the expected replica set. */
  seed(request: SeedRequest = {}): Promise<MemberConnection> {
    return this.#trySeeds(request, async member => member);
  }

  /** Connects to a seed and reads replica-set status through it. */
  discover(request: SeedRequest = {}): Promise<DiscoveryConnection> {
    return this.#trySeeds(request, async member => Object.assign(member, { status: await readTopology(member) }));
  }

  /** Reads replica-set status through a temporary connection. */
  async status(request: SeedRequest = {}): Promise<ReplSetGetStatus> {
    const discovered = await this.discover(request);

    try {
      return discovered.status;
    } finally {
      await discovered.client.close();
    }
  }

  /** Builds, patches and connects one client, closing it if any step fails. */
  async #open(uri: string, options: MongoClientOptions): Promise<MemberConnection> {
    const client = this.#settings.createClient(uri, options);

    try {
      const member = observeMember(client);

      if (this.#settings.disableMonitoring) {
        const { disableMonitoring } = await import('./no-monitoring/index.js');
        disableMonitoring(client);
      }

      await client.connect();

      return member;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  /** Tries seeds in turn until one connects, belongs to the expected set, and is accepted. */
  async #trySeeds<T>(request: SeedRequest, accept: (member: MemberConnection) => Promise<T>): Promise<T> {
    const { uri } = this.#settings;
    const resolved = request.seeds ? { hosts: request.seeds, options: request.options } : await resolveSeeds(uri, request.options);
    const expectedSet = resolved.options?.replicaSet ?? new ConnectionString(uri).searchParams.get('replicaSet');
    const settings = { serverSelectionTimeoutMS: 5000, ...resolved.options, directConnection: true };
    let failure: unknown;

    for (const seed of resolved.hosts) {
      const candidate = directUri(uri, seed, resolved.options);
      let member: MemberConnection | undefined;

      try {
        member = await this.#open(candidate, settings);

        if (!member.setName || member.type === 'Mongos') {
          throw new ServerlessDriverError('Discovery requires a replica set; standalone and sharded clusters are unsupported.');
        }

        if (expectedSet != null && member.setName !== expectedSet) {
          throw new ServerlessDriverError(
            `Expected replica set "${expectedSet}", but "${new ConnectionString(candidate).hosts.join(', ')}" reported "${member.setName}".`
          );
        }

        member.host ??= new ConnectionString(candidate).hosts[0];

        return await accept(member);
      } catch (error) {
        failure = error;
        await member?.client.close().catch(() => {});
      }
    }

    throw failure ?? new ServerlessDriverError('No discovery seeds are available.');
  }
}

/** Reads and validates replica-set status, adding the resolved authentication defaults. */
export async function readTopology(member: MemberConnection): Promise<ReplSetGetStatus> {
  const status = await member.client.db('admin').command({ replSetGetStatus: 1 });
  assertStatus(status);
  // Throws for a status with no usable primary, so discovery moves on to the next seed.
  parseTopology(status);
  const credentials = member.client.options.credentials;

  return credentials
    ? { ...status, authentication: { mechanism: credentials.mechanism, source: credentials.source } }
    : status;
}
