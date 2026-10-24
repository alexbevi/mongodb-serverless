import assert from 'node:assert/strict';

export const variants = ['native', 'no-plugin', 'ssm', 'ssm-uncached'] as const;

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
  discoveryCommands: number;
  ssmReads: number;
  ssmWrites: number;
  cold: boolean;
}

export function verifyPattern(sample: PatternEvidence): void {
  assert.ok(sample.cold, 'Every sample must be cold');
  assert.equal(sample.ssmReads, 1, 'Every cold invocation must make one SSM read');
  assert.equal(sample.ssmWrites, sample.variant === 'ssm-uncached' ? 1 : 0, 'Unexpected SSM topology writes');
  assert.ok(['PRIMARY', 'SECONDARY'].includes(sample.servedRole), 'Read must reach a healthy member');

  if (sample.operation === 'write') assert.equal(sample.servedRole, 'PRIMARY', 'Writes must reach the primary');

  if (sample.variant === 'native') return;
  assert.equal(sample.monitorSockets, 0, 'Direct patterns must disable monitor sockets');
  const expected = sample.variant !== 'ssm' && sample.operation === 'write' && sample.seedRole === 'SECONDARY' ? 2 : 1;
  assert.equal(sample.sockets, expected, 'Unexpected MongoDB socket count');
  assert.equal(sample.authenticatedSockets, expected, 'Each MongoDB socket must authenticate');
  assert.equal(sample.discoveryCommands, sample.variant === 'ssm-uncached' || expected === 2 ? 1 : 0, 'Unexpected topology discovery');
}
