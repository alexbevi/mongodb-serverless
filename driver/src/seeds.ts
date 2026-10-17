import { ConnectionString } from 'mongodb-connection-string-url';
import * as dns from 'node:dns/promises';
import { ServerlessDriverError } from './errors.js';

type Resolver = Pick<typeof dns, 'resolveSrv' | 'resolveTxt'>;

export async function resolveSeedOptions(uri: string, resolver: Resolver = dns): Promise<string> {
  const parsed = new ConnectionString(uri);

  if (!parsed.isSRV) return uri;

  const host = parsed.hosts[0]!;
  let records: string[][];

  try {
    records = await resolver.resolveTxt(host);
  } catch (error) {
    if (!isMissingRecord(error)) throw error;

    records = [];
  }

  if (records.length > 1) throw new ServerlessDriverError('Multiple DNS TXT records are unsupported.');

  const options = new URLSearchParams(records[0]?.join(''));

  for (const [key, value] of options) {
    if (!['authSource', 'replicaSet', 'loadBalanced'].includes(key) || value === '') {
      throw new ServerlessDriverError('DNS TXT records may only set authSource, replicaSet, and loadBalanced.');
    }

    if (!hasOption(parsed, key)) parsed.searchParams.set(key, value);
  }

  return parsed.toString();
}

export async function resolveSeeds(uri: string, resolver: Resolver = dns) {
  const parsed = new ConnectionString(await resolveSeedOptions(uri, resolver));

  if (!parsed.isSRV) return { uri, hosts: parsed.hosts };

  const host = parsed.hosts[0]!;
  const service = parsed.searchParams.get('srvServiceName') ?? 'mongodb';
  const records = await resolver.resolveSrv(`_${service}._tcp.${host}`);
  const domain = host.toLowerCase().split('.');
  const parent = domain.length > 2 ? domain.slice(1).join('.') : domain.join('.');

  if (records.length === 0) throw new ServerlessDriverError('DNS SRV returned no cluster members.');

  for (const record of records) {
    if (!record.name.toLowerCase().replace(/\.$/, '').endsWith(`.${parent}`)) {
      throw new ServerlessDriverError('DNS SRV returned a member outside the seed domain.');
    }
  }

  parsed.protocol = 'mongodb:';
  parsed.hosts = records.map(record => `${record.name.replace(/\.$/, '')}:${record.port}`);

  if (!hasOption(parsed, 'tls') && !hasOption(parsed, 'ssl')) parsed.searchParams.set('tls', 'true');

  for (const key of ['srvServiceName', 'srvMaxHosts']) parsed.searchParams.delete(key);

  return { uri: parsed.toString(), hosts: parsed.hosts };
}

function hasOption(uri: ConnectionString, name: string): boolean {
  return [...uri.searchParams.keys()].some(key => key.toLowerCase() === name.toLowerCase());
}

function isMissingRecord(error: unknown): error is { code: 'ENODATA' | 'ENOTFOUND' } {
  return error !== null && typeof error === 'object' && 'code' in error &&
    (error.code === 'ENODATA' || error.code === 'ENOTFOUND');
}
