import { isResolvedAuthentication, type ResolvedAuthentication } from '../../plugins/shared/src/index.js';
import type { ReplSetGetStatus, ReplSetGetStatusMember } from './plugin.js';
import { InvalidTopologyError, NoPrimaryError } from './errors.js';

export interface Topology {
  setName: string | undefined;
  authentication?: ResolvedAuthentication;
  /** `host:port` of the primary. */
  primary: string;
  /** `host:port` of each healthy secondary, in the order reported. */
  secondaries: string[];
}

/**
 * Numeric member states, used when `stateStr` is absent.
 *
 * @see https://www.mongodb.com/docs/manual/reference/replica-states/
 */
const STATE_NAMES = new Map<number, string>([
  [0, 'STARTUP'],
  [1, 'PRIMARY'],
  [2, 'SECONDARY'],
  [3, 'RECOVERING'],
  [5, 'STARTUP2'],
  [6, 'UNKNOWN'],
  [7, 'ARBITER'],
  [8, 'DOWN'],
  [9, 'ROLLBACK'],
  [10, 'REMOVED']
]);

const HOST_PORT = /^(?<host>\[[^\]]+\]|[^:]+):(?<port>\d{1,5})$/;

/** Reads the routing targets out of a `replSetGetStatus` document. */
export function parseTopology(status: ReplSetGetStatus): Topology {
  if (!Array.isArray(status.members)) {
    throw new InvalidTopologyError(
      'Topology has no members array; it must be a replSetGetStatus document'
    );
  }

  if (status.members.length === 0) {
    throw new InvalidTopologyError('Topology reports no members');
  }

  if (status.authentication !== undefined && !isResolvedAuthentication(status.authentication)) {
    throw new InvalidTopologyError('Topology authentication must contain a mechanism and source');
  }

  const primaries: string[] = [];
  const secondaries: string[] = [];

  for (const member of status.members) {
    const name = hostPortOf(member);
    const state = stateOf(member);

    if (!isHealthy(member)) continue;

    if (state === 'PRIMARY') primaries.push(name);
    else if (state === 'SECONDARY') secondaries.push(name);
  }

  if (primaries.length > 1) {
    throw new InvalidTopologyError(
      `Topology reports ${primaries.length} primaries (${primaries.join(', ')}); it is stale`
    );
  }

  const primary = primaries[0];

  if (primary == null) {
    throw new NoPrimaryError(
      'Topology has no healthy PRIMARY, so writes cannot be routed. It may be stale or mid-election.'
    );
  }

  const topology: Topology = { setName: isString(status.set) ? status.set : undefined, primary, secondaries };

  if (status.authentication !== undefined) topology.authentication = status.authentication;

  return topology;
}

function hostPortOf(member: ReplSetGetStatusMember): string {
  if (!hasMemberName(member) || member.name === '') {
    throw new InvalidTopologyError('Topology member has no name; each needs a "host:port" name');
  }

  const { name } = member;

  if (!HOST_PORT.test(name)) {
    throw new InvalidTopologyError(`Topology member name "${name}" is not "host:port"`);
  }

  return name;
}

function stateOf(member: ReplSetGetStatusMember): string | undefined {
  if (isString(member.stateStr)) return member.stateStr;

  if (isNumber(member.state)) return STATE_NAMES.get(member.state);

  return undefined;
}

/** `health` is absent in hand-written topologies, so only 0 means unhealthy. */
function isHealthy(member: ReplSetGetStatusMember): boolean {
  return member.health == null || member.health === 1;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function hasMemberName(value: ReplSetGetStatusMember): value is { name: string } {
  return value !== null && typeof value === 'object' && 'name' in value && isString(value.name);
}
