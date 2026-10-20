import { expect, it } from 'vitest';
import { verifyPattern, type PatternEvidence } from '../patterns.js';

it('accepts both random write landings and rejects cached DNS or extra parameter reads', () => {
  const noPlugin: PatternEvidence = {
    variant: 'no-plugin', operation: 'write', servedRole: 'PRIMARY', seedRole: 'PRIMARY',
    sockets: 1, authenticatedSockets: 1, monitorSockets: 0, dns: ['TXT', 'SRV'],
    discoveryCommands: 0, ssmReads: 1, ssmWrites: 0, cold: true
  };

  expect(() => verifyPattern(noPlugin)).not.toThrow();
  expect(() => verifyPattern({ ...noPlugin, seedRole: 'SECONDARY', sockets: 2, authenticatedSockets: 2, discoveryCommands: 1 })).not.toThrow();
  expect(() => verifyPattern({ ...noPlugin, servedRole: 'SECONDARY' })).toThrow(/primary/i);
  expect(() => verifyPattern({ ...noPlugin, operation: 'read', servedRole: 'SECONDARY', seedRole: 'SECONDARY' })).not.toThrow();
  expect(() => verifyPattern({ ...noPlugin, operation: 'read', sockets: 2, authenticatedSockets: 2 })).toThrow(/socket/i);
  expect(() => verifyPattern({ ...noPlugin, ssmReads: 2 })).toThrow(/SSM/i);
  const cached = { ...noPlugin, variant: 'ssm', dns: [], discoveryCommands: 0 } as const;
  expect(() => verifyPattern({ ...cached, dns: [] })).not.toThrow();
  expect(() => verifyPattern({ ...cached, dns: ['SRV'] })).toThrow(/DNS/i);
  expect(() => verifyPattern({ ...noPlugin, cold: false })).toThrow(/cold/i);
});

it('measures one discovery and topology write for an aws-ssm cache miss', () => {
  for (const operation of ['read', 'write'] as const) {
    for (const seedRole of ['PRIMARY', 'SECONDARY']) {
      const sockets = operation === 'write' && seedRole === 'SECONDARY' ? 2 : 1;

      const sample = {
        variant: 'ssm-uncached', operation, servedRole: operation === 'write' ? 'PRIMARY' : seedRole, seedRole,
        sockets, authenticatedSockets: sockets, monitorSockets: 0, dns: ['TXT', 'SRV'],
        discoveryCommands: 1, ssmReads: 1, ssmWrites: 1, cold: true
      } as const;

      expect(() => verifyPattern({ ...sample, dns: [...sample.dns] })).not.toThrow();

      for (const change of [{ ssmWrites: 0 }, { ssmWrites: 2 }, { discoveryCommands: 0 }, { ssmReads: 2 }, { dns: [] }]) {
        expect(() => verifyPattern({ ...sample, dns: [...sample.dns], ...change })).toThrow();
      }
    }
  }
});
