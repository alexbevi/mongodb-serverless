import assert from 'node:assert/strict';

export const variants = ['native', 'no-plugin', 'ssm'] as const;

export type PatternVariant = typeof variants[number];

export type PatternOperation = 'read' | 'write';

export interface PatternEvidence {
  variant: PatternVariant;
  operation: PatternOperation;
  servedRole: string;
  seedRole: string;
  sockets: number;
  authenticatedSockets: number;
  monitorSockets: number;
  dns: string[];
  discoveryCommands: number;
  ssmReads: number;
  ssmWrites: number;
  cold: boolean;
}

export function verifyPattern(sample: PatternEvidence): void {
  assert.ok(sample.cold, 'Every sample must be cold');
  assert.equal(sample.ssmReads, 1, 'Every cold invocation must make one SSM read');
  assert.equal(sample.ssmWrites, 0, 'A measured cache hit must not write SSM');
  assert.ok(['PRIMARY', 'SECONDARY'].includes(sample.servedRole), 'Read must reach a healthy member');

  if (sample.operation === 'write') assert.equal(sample.servedRole, 'PRIMARY', 'Writes must reach the primary');

  if (sample.variant === 'native' || sample.variant === 'no-plugin') {
    assert.deepEqual([...sample.dns].sort(), ['SRV', 'TXT'], 'Each uncached invocation must resolve SRV and TXT DNS');
  } else {
    assert.equal(sample.dns.length, 0, 'Cached routing must skip SRV/TXT DNS');
  }

  if (sample.variant === 'native') return;
  assert.equal(sample.monitorSockets, 0, 'Direct patterns must disable monitor sockets');
  const expected = sample.variant === 'no-plugin' && sample.operation === 'write' && sample.seedRole === 'SECONDARY' ? 2 : 1;
  assert.equal(sample.sockets, expected, 'Unexpected MongoDB socket count');
  assert.equal(sample.authenticatedSockets, expected, 'Each MongoDB socket must authenticate');
  assert.equal(sample.discoveryCommands, expected === 2 ? 1 : 0, 'Unexpected topology discovery');
}
