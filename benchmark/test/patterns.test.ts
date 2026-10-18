import { expect, it } from 'vitest';
import { verifyPattern, type PatternEvidence } from '../patterns.js';

it('accepts both random write landings and rejects cached DNS or extra parameter reads', () => {
  const noPlugin: PatternEvidence = {
    variant: 'no-plugin', operation: 'write', servedRole: 'PRIMARY', seedRole: 'PRIMARY',
    sockets: 1, authenticatedSockets: 1, monitorSockets: 0, dns: ['TXT', 'SRV'],
    discoveryCommands: 1, ssmReads: 1, ssmWrites: 0, cold: true
  };

  expect(() => verifyPattern(noPlugin)).not.toThrow();
  expect(() => verifyPattern({ ...noPlugin, seedRole: 'SECONDARY', sockets: 2, authenticatedSockets: 2 })).not.toThrow();
  expect(() => verifyPattern({ ...noPlugin, servedRole: 'SECONDARY' })).toThrow(/primary/i);
  expect(() => verifyPattern({ ...noPlugin, operation: 'read', servedRole: 'SECONDARY', seedRole: 'SECONDARY' })).not.toThrow();
  expect(() => verifyPattern({ ...noPlugin, operation: 'read', sockets: 2, authenticatedSockets: 2 })).toThrow(/socket/i);
  expect(() => verifyPattern({ ...noPlugin, ssmReads: 2 })).toThrow(/SSM/i);
  const cached = { ...noPlugin, variant: 'ssm', dns: [], discoveryCommands: 0 } as const;
  expect(() => verifyPattern({ ...cached, dns: [] })).not.toThrow();
  expect(() => verifyPattern({ ...cached, dns: ['SRV'] })).toThrow(/DNS/i);
  expect(() => verifyPattern({ ...noPlugin, cold: false })).toThrow(/cold/i);
});
