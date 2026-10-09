import { describe, expect, it } from 'vitest';
import { parseTopology } from '../src/topology.js';
import { InvalidTopologyError, NoPrimaryError, NoTopologyError } from '../src/errors.js';

const member = (name: string, stateStr: string, health = 1) => ({ name, stateStr, health });

describe('parseTopology', () => {
  it('reads the primary and secondaries from a healthy set', () => {
    const topology = parseTopology({
      set: 'rs0',
      members: [
        member('a:27017', 'PRIMARY'),
        member('b:27017', 'SECONDARY'),
        member('c:27017', 'SECONDARY')
      ]
    });

    expect(topology.setName).toBe('rs0');
    expect(topology.primary).toBe('a:27017');
    expect(topology.secondaries).toEqual(['b:27017', 'c:27017']);
  });

  it('excludes arbiters from secondaries', () => {
    const topology = parseTopology({
      members: [member('a:27017', 'PRIMARY'), member('b:27017', 'SECONDARY'), member('c:27017', 'ARBITER')]
    });

    expect(topology.secondaries).toEqual(['b:27017']);
  });

  it('excludes unhealthy secondaries', () => {
    const topology = parseTopology({
      members: [member('a:27017', 'PRIMARY'), member('b:27017', 'SECONDARY', 0)]
    });

    expect(topology.secondaries).toEqual([]);
  });

  it('excludes members in a transient state', () => {
    const topology = parseTopology({
      members: [
        member('a:27017', 'PRIMARY'),
        member('b:27017', 'STARTUP2'),
        member('c:27017', 'RECOVERING'),
        member('d:27017', 'ROLLBACK')
      ]
    });

    expect(topology.secondaries).toEqual([]);
  });

  it('yields no secondary for a single-node set', () => {
    const topology = parseTopology({ members: [member('a:27017', 'PRIMARY')] });

    expect(topology.primary).toBe('a:27017');
    expect(topology.secondaries).toEqual([]);
  });

  it('falls back to the numeric state when stateStr is absent', () => {
    const topology = parseTopology({
      members: [
        { name: 'a:27017', state: 1, health: 1 },
        { name: 'b:27017', state: 2, health: 1 },
        { name: 'c:27017', state: 7, health: 1 }
      ]
    });

    expect(topology.primary).toBe('a:27017');
    expect(topology.secondaries).toEqual(['b:27017']);
  });

  it('treats a missing health field as healthy', () => {
    const topology = parseTopology({
      members: [
        { name: 'a:27017', stateStr: 'PRIMARY' },
        { name: 'b:27017', stateStr: 'SECONDARY' }
      ]
    });

    expect(topology.secondaries).toEqual(['b:27017']);
  });

  it('accepts bracketed IPv6 member names', () => {
    const topology = parseTopology({
      members: [member('[::1]:27017', 'PRIMARY'), member('[fe80::1]:27018', 'SECONDARY')]
    });

    expect(topology.primary).toBe('[::1]:27017');
    expect(topology.secondaries).toEqual(['[fe80::1]:27018']);
  });

  it('throws NoPrimaryError when no member is primary', () => {
    expect(() =>
      parseTopology({ members: [member('a:27017', 'SECONDARY'), member('b:27017', 'SECONDARY')] })
    ).toThrow(NoPrimaryError);
  });

  it('throws NoPrimaryError when the primary is unhealthy', () => {
    expect(() => parseTopology({ members: [member('a:27017', 'PRIMARY', 0)] })).toThrow(
      NoPrimaryError
    );
  });

  it('throws NoTopologyError on a null status', () => {
    expect(() => parseTopology(null)).toThrow(NoTopologyError);
  });

  it('throws InvalidTopologyError when members is not an array', () => {
    expect(() => {
      // @ts-expect-error Exercise a malformed document with no members array.
      return parseTopology({ set: 'rs0' });
    }).toThrow(InvalidTopologyError);
  });

  it('throws InvalidTopologyError on an empty members array', () => {
    expect(() => parseTopology({ members: [] })).toThrow(InvalidTopologyError);
  });

  it('throws InvalidTopologyError on a member name without a port', () => {
    expect(() => parseTopology({ members: [{ name: 'a', stateStr: 'PRIMARY', health: 1 }] })).toThrow(
      InvalidTopologyError
    );
  });

  it('names the offending member when a name is malformed', () => {
    expect(() =>
      parseTopology({ members: [{ name: 'a:nope', stateStr: 'PRIMARY', health: 1 }] })
    ).toThrow(/a:nope/);
  });

  it('throws InvalidTopologyError when a member has no name', () => {
    expect(() => {
      // @ts-expect-error Exercise a malformed member with no name.
      return parseTopology({ members: [{ stateStr: 'PRIMARY', health: 1 }] });
    }).toThrow(InvalidTopologyError);
  });

  it('throws InvalidTopologyError when two members report primary', () => {
    expect(() =>
      parseTopology({ members: [member('a:27017', 'PRIMARY'), member('b:27017', 'PRIMARY')] })
    ).toThrow(InvalidTopologyError);
  });
});
