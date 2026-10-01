import { describe, expect, it } from 'vitest';
import { resolvePlugin, validatePlugin } from '../../plugins/shared/src/index.js';
import { InvalidPluginError, MissingPluginError } from '../../plugins/shared/src/index.js';
import type { ReplSetGetStatus, TopologyPlugin } from '../../plugins/shared/src/index.js';

const status: ReplSetGetStatus = { set: 'rs0', members: [] };

const stub = (): TopologyPlugin => ({
  name: 'stub',
  version: '1.0.0',
  author: 'test',
  setup: async () => {},
  verify: async () => {},
  read: async () => status,
  write: async () => {}
});

/**
 * The watcher resolves plugins the same way the driver does, through the
 * contract rather than a second implementation.
 */
describe('plugin resolution from the watcher', () => {
  it('passes an instance through', async () => {
    const plugin = stub();

    await expect(resolvePlugin(plugin)).resolves.toBe(plugin);
  });

  it('throws MissingPluginError when none is supplied', async () => {
    await expect(resolvePlugin()).rejects.toThrow(MissingPluginError);
  });

  it('validates structurally', () => {
    expect(() => validatePlugin(stub(), 'test')).not.toThrow();
    expect(() => validatePlugin({ name: 'x' }, 'test')).toThrow(InvalidPluginError);
  });
});
