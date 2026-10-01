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
  [key: string]: unknown;
}

export interface ReplSetGetStatus {
  /** Replica set name. */
  set?: string;
  members: ReplSetGetStatusMember[];
  [key: string]: unknown;
}
