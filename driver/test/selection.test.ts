import { expect, it } from 'vitest';
import { chooseHost, serves } from '../src/selection.js';
import type { Topology } from '../src/topology.js';

const topology: Topology = { setName: 'rs0', primary: 'a:27017', secondaries: ['b:27017', 'c:27017'] };

it('sends writes to the primary', () => {
  expect(chooseHost('write', topology, ['b:27017'])).toBe('a:27017');
});

it('prefers a connected secondary for reads, then the first healthy one, then the primary', () => {
  expect(chooseHost('read', topology, ['a:27017', 'c:27017'])).toBe('c:27017');
  expect(chooseHost('read', topology, ['a:27017'])).toBe('b:27017');
  expect(chooseHost('read', { ...topology, secondaries: [] }, [])).toBe('a:27017');
});

it('reuses any connected member for unrestricted reads', () => {
  expect(chooseHost('any', topology, ['a:27017'])).toBe('a:27017');
  expect(chooseHost('any', topology, ['gone:27017'])).toBe('b:27017');
});

it('decides whether a reported role can serve a route', () => {
  expect(serves('write', 'RSPrimary')).toBe(true);
  expect(serves('write', 'RSSecondary')).toBe(false);
  expect(serves('read', 'RSSecondary')).toBe(true);
  expect(serves('read', 'RSPrimary')).toBe(false);
  expect(serves('any', 'RSPrimary')).toBe(true);
  expect(serves('any', 'Unknown')).toBe(false);
});
