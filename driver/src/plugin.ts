// The plugin contract, re-exported from the shared source that is compiled
// into this package. Imported by relative path, not by package name, so the
// driver still depends on no plugin package.
export type {
  TopologyPlugin,
  ReplSetGetStatus,
  ReplSetGetStatusMember
} from '../../plugins/shared/src/index.js';

import type { TopologyPlugin } from '../../plugins/shared/src/index.js';

export const uncachedTopology: TopologyPlugin = {
  name: 'uncached',
  version: '1',
  author: 'mongodb-serverless',
  async setup() {},
  async verify() {},
  async read() { return null; },
  async write() {}
};
