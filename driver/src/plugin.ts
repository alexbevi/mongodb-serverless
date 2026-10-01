/**
 * The plugin shape the driver requires.
 *
 * Declared here rather than imported from the shared plugin contract so
 * the driver depends on no plugin package. Validation is structural, so a
 * plugin satisfies this by shape without sharing a class with us.
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
  set?: string;
  members: ReplSetGetStatusMember[];
  [key: string]: unknown;
}

export interface TopologyPlugin {
  readonly name: string;
  readonly version: string;
  readonly author: string;

  setup(): Promise<void>;
  verify(): Promise<void>;
  read(): Promise<ReplSetGetStatus>;
  write(status: ReplSetGetStatus): Promise<void>;
}
