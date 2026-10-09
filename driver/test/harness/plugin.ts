import type { ReplSetGetStatus, TopologyPlugin } from '../../src/plugin.js';

/**
 * A plugin backed by a topology the test sets directly.
 *
 * Stands in for whatever a real plugin reads from, so an integration test can
 * serve live `replSetGetStatus` output, then change it to cover staleness
 * without touching the cluster.
 */
export class TestPlugin implements TopologyPlugin {
  readonly name = 'Test';
  readonly version = '0.0.0';
  readonly author = 'test';

  reads = 0;

  #status: ReplSetGetStatus;

  constructor(status: ReplSetGetStatus) {
    this.#status = status;
  }

  async setup(): Promise<void> {}

  async verify(): Promise<void> {}

  async read(): Promise<ReplSetGetStatus> {
    this.reads += 1;

    return this.#status;
  }

  async write(status: ReplSetGetStatus): Promise<void> {
    this.#status = status;
  }
}
