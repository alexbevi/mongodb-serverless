import type { MongoClient, MongoClientOptions } from 'mongodb';
import { requireMongo, assertVersion } from './native.js';
import { ServerlessDriverError, UnsupportedOperationError } from './errors.js';

export interface Seedlist {
  hosts: string[];
  options: MongoClientOptions;
}

export async function resolveSeeds(uri: string, options: MongoClientOptions = {}): Promise<Seedlist> {
  const connectionString: {
    parseOptions: (uri: string, client: undefined, options: MongoClientOptions) => MongoClient['options'];
    resolveSRVRecord: SrvResolver;
  } = requireMongo('./connection_string.js');

  if (typeof connectionString.parseOptions !== 'function') {
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

  const settings = { ...options, tls: parsed.tls };
  delete settings.srvServiceName;
  delete settings.srvMaxHosts;

  if (parsed.credentials) settings.authSource = parsed.credentials.source;

  if (parsed.replicaSet) settings.replicaSet = parsed.replicaSet;

  const candidates = hosts.map(String);

  for (let index = candidates.length - 1; index > 0; index--) {
    const selected = Math.floor(Math.random() * (index + 1));

    [candidates[index], candidates[selected]] = [candidates[selected]!, candidates[index]!];
  }

  return { hosts: candidates, options: settings };
}

type SrvResolver = (options: MongoClient['options']) => Promise<MongoClient['options']['hosts']>;

function isResolver(value: unknown): value is SrvResolver {
  return typeof value === 'function';
}
