import type { MongoClient, MongoClientOptions } from 'mongodb';
import { requireMongo, assertVersion } from './native.js';
import { ServerlessDriverError, UnsupportedOperationError } from './errors.js';
import { withoutSrvOptions } from './uri.js';

export interface Seedlist {
  hosts: string[];
  options: MongoClientOptions;
}

/** Resolves the seed list in random order, so clients spread their first connections across members. */
export async function resolveSeeds(uri: string, options: MongoClientOptions = {}, random: () => number = Math.random): Promise<Seedlist> {
  const connectionString: {
    parseOptions: OptionsParser;
    resolveSRVRecord: SrvResolver;
  } = requireMongo('./connection_string.js');

  if (!isParser(connectionString.parseOptions)) {
    throw new UnsupportedOperationError('Unsupported mongodb connection-string parser');
  }

  const parsed = connectionString.parseOptions(uri, undefined, options);
  let hosts = parsed.hosts;

  if (parsed.srvHost) {
    const manifest: { version: string } = requireMongo('../package.json');
    assertVersion(manifest.version);

    if (!isResolver(connectionString.resolveSRVRecord)) {
      throw new UnsupportedOperationError('Unsupported mongodb SRV resolver');
    }

    hosts = await connectionString.resolveSRVRecord(parsed);
  }

  if (parsed.loadBalanced) {
    throw new ServerlessDriverError('Load-balanced clusters are unsupported. Discovery requires a replica set.');
  }

  const settings: MongoClientOptions = { ...withoutSrvOptions(options), tls: parsed.tls };

  if (parsed.credentials) settings.authSource = parsed.credentials.source;

  if (parsed.replicaSet) settings.replicaSet = parsed.replicaSet;

  return { hosts: shuffle(hosts.map(String), random), options: settings };
}

/** A Fisher–Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));

    [shuffled[index], shuffled[selected]] = [shuffled[selected]!, shuffled[index]!];
  }

  return shuffled;
}

type SrvResolver = (options: MongoClient['options']) => Promise<MongoClient['options']['hosts']>;

function isResolver(value: unknown): value is SrvResolver {
  return typeof value === 'function';
}

type OptionsParser = (uri: string, client: undefined, options: MongoClientOptions) => MongoClient['options'];

function isParser(value: unknown): value is OptionsParser {
  return typeof value === 'function';
}
