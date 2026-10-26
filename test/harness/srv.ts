import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { vi } from 'vitest';

export function stubSrvRecords(port: number, txt = 'authSource=admin&replicaSet=securetest') {
  // SAFETY: The fixture implements only the SRV and TXT overloads used by the native driver's resolver.
  const resolve = (async (_hostname: string, type: string) => {
    if (type === 'SRV') return [{ name: 'member.cluster.localhost', port, priority: 0, weight: 0 }];

    if (type === 'TXT') return [[txt]];

    throw new Error(`Unexpected DNS record type: ${type}`);
  }) as typeof dns.promises.resolve;

  return vi.spyOn(dns.promises, 'resolve').mockImplementation(resolve);
}

export const localLookup: LookupFunction = (hostname, options, callback) =>
  dns.lookup('localhost', options, callback);
