/**
 * The subset of `replSetGetStatus` the driver routes on. The server returns
 * considerably more; plugins pass it through untouched.
 *
 * @see https://www.mongodb.com/docs/manual/reference/command/replSetGetStatus/
 */
export interface ReplSetGetStatusMember {
  /** `host:port`. */
  name: string;
  /** Numeric member state. 1 is PRIMARY, 2 is SECONDARY, 7 is ARBITER. */
  state?: number;
  /** String member state, e.g. `PRIMARY`. Preferred over `state` when present. */
  stateStr?: string;
  /** 1 when the member is reachable. */
  health?: number;
  [key: string]: StatusValue;
}

export interface ReplSetGetStatus {
  /** Replica set name. */
  set?: string;
  members: ReplSetGetStatusMember[];
  [key: string]: StatusValue;
}

/** Values carried by BSON commands or their JSON representation. */
export type StatusValue =
  | string | number | boolean | bigint | null | undefined
  | Date | RegExp | Uint8Array
  | { readonly _bsontype: string }
  | StatusValue[]
  | { [key: string]: StatusValue };

function isStatusValue(value: unknown, ancestors = new Set<object>()): value is StatusValue {
  if (value == null) return true;

  if (typeof value !== 'object') {
    return typeof value === 'string' || typeof value === 'number' ||
      typeof value === 'boolean' || typeof value === 'bigint';
  }

  if (value instanceof Date || value instanceof RegExp || value instanceof Uint8Array) return true;

  // BSON scalars are structural so the contract needs no BSON package at runtime.
  if ('_bsontype' in value && typeof value._bsontype === 'string') return true;

  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Object.values(value).every(entry => isStatusValue(entry, ancestors));
  ancestors.delete(value);

  return valid;
}

function isStatusObject(value: unknown): value is { [key: string]: StatusValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isStatusValue(value);
}

function isMember(value: unknown): value is ReplSetGetStatusMember {
  return isStatusObject(value) && typeof value.name === 'string' &&
    (value.state === undefined || typeof value.state === 'number') &&
    (value.stateStr === undefined || typeof value.stateStr === 'string') &&
    (value.health === undefined || typeof value.health === 'number');
}

export function assertStatus(value: unknown): asserts value is ReplSetGetStatus {
  if (!isStatusObject(value)) throw new TypeError('Topology must be a BSON or JSON object');

  if (value.set !== undefined && !isString(value.set)) {
    throw new TypeError('Topology set must be a string');
  }

  if (!Array.isArray(value.members)) throw new TypeError('Topology has no members array');

  if (!value.members.every(isMember)) throw new TypeError('Topology contains an invalid member');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function parseStatus(text: string): ReplSetGetStatus {
  const value: unknown = JSON.parse(text);
  assertStatus(value);

  return value;
}
