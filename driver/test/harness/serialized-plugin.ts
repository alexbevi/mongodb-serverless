import { parseStatus } from '../../../plugins/shared/src/index.js';
import type { ReplSetGetStatus, TopologyPlugin } from '../../src/plugin.js';

export class SerializedPlugin implements TopologyPlugin {
  readonly name = 'Serialized test topology';
  readonly version = '1';
  readonly author = 'test';
  document: string | undefined;

  async setup(): Promise<void> {}
  async verify(): Promise<void> {}

  async read(): Promise<ReplSetGetStatus | null> {
    return this.document === undefined ? null : parseStatus(this.document);
  }

  async write(status: ReplSetGetStatus): Promise<void> {
    this.document = JSON.stringify(status);
  }
}
