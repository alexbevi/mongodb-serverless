import { describe, expect, it } from 'vitest';
import { ServerlessPlugin, PluginReadOnlyError, type PluginConfig } from '../src/index.js';
import type { ReplSetGetStatus } from '../src/index.js';

class StubPlugin extends ServerlessPlugin {
  readonly name = 'stub';
  readonly version = '1.0.0';
  readonly author = 'test';

  async setup(): Promise<void> {}
  async verify(): Promise<void> {}
  async read(): Promise<ReplSetGetStatus> {
    return { set: 'rs0', members: [] };
  }
  async write(): Promise<void> {}

  /** Exposes the protected guard so a test can observe it. */
  guard(): void {
    this.assertWritable();
  }
}

class ReadOnlyStubPlugin extends StubPlugin {
  constructor() {
    super({ writable: false });
  }
}

interface RegionConfig extends PluginConfig {
  region: string;
}

class RegionPlugin extends ServerlessPlugin<RegionConfig> {
  readonly name = 'region';
  readonly version = '1.0.0';
  readonly author = 'test';

  constructor(options: { writable?: boolean } = {}) {
    super({ region: 'us-east-1', ...options });
  }

  async setup(): Promise<void> {}
  async verify(): Promise<void> {}
  async read(): Promise<ReplSetGetStatus> {
    return { set: 'rs0', members: [] };
  }
  async write(): Promise<void> {}
}

describe('ServerlessPlugin', () => {
  it('rejects the removed polling interval', () => {
    // @ts-expect-error Polling is no longer part of the plugin contract.
    expect(() => new StubPlugin().get('refreshIntervalMS')).toThrow(/Unknown config key/);
  });

  it('defaults clusterTopologyVariableName to __MONGODB_CLUSTER_TOPOLOGY', () => {
    expect(new StubPlugin().get('clusterTopologyVariableName')).toBe('__MONGODB_CLUSTER_TOPOLOGY');
  });

  it('round-trips a value through set and get', () => {
    const plugin = new StubPlugin();
    plugin.set('clusterTopologyVariableName', 'MY_TOPOLOGY');

    expect(plugin.get('clusterTopologyVariableName')).toBe('MY_TOPOLOGY');
  });

  it('keeps config per instance', () => {
    const one = new StubPlugin();
    const two = new StubPlugin();
    one.set('clusterTopologyVariableName', 'MY_TOPOLOGY');

    expect(two.get('clusterTopologyVariableName')).toBe('__MONGODB_CLUSTER_TOPOLOGY');
  });

  it('leaves connection-string settings to the plugins that supply one', () => {
    // @ts-expect-error Only plugins that supply a connection string add this key.
    expect(() => new StubPlugin().get('connectionStringVariableName')).toThrow(/Unknown config key/);
  });

  it('is writable unless constructed read-only, since discovery writes topology', () => {
    expect(new StubPlugin().writable).toBe(true);
    expect(new RegionPlugin({ writable: false }).writable).toBe(false);
  });

  it('rejects an unknown key on set', () => {
    const plugin = new StubPlugin();

    expect(() => {
      // @ts-expect-error Exercise an invalid key supplied by a JavaScript caller.
      plugin.set('nope', 1);
    }).toThrow(/nope/);
  });

  it('rejects an unknown key on get', () => {
    const plugin = new StubPlugin();

    expect(() => {
      // @ts-expect-error Exercise an invalid key supplied by a JavaScript caller.
      plugin.get('nope');
    }).toThrow(/nope/);
  });

  it('keeps base defaults when a subclass extends the config', () => {
    const plugin = new RegionPlugin();

    expect(plugin.get('region')).toBe('us-east-1');
    expect(plugin.get('clusterTopologyVariableName')).toBe('__MONGODB_CLUSTER_TOPOLOGY');
  });

  it('reports static plugin details', () => {
    const plugin = new StubPlugin();

    expect(plugin.name).toBe('stub');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.author).toBe('test');
  });

  it('cannot be constructed directly', () => {
    expect(() => Reflect.construct(ServerlessPlugin, [])).toThrow(/abstract/i);
  });

describe('writability', () => {
  it('is read-only when constructed read-only', () => {
    expect(new ReadOnlyStubPlugin().writable).toBe(false);
  });

  it('throws PluginReadOnlyError from assertWritable when read-only', () => {
    expect(() => new ReadOnlyStubPlugin().guard()).toThrow(PluginReadOnlyError);
  });

  it('names the plugin in the error', () => {
    expect(() => new ReadOnlyStubPlugin().guard()).toThrow(/stub/);
  });

  it('permits assertWritable by default', () => {
    expect(() => new StubPlugin().guard()).not.toThrow();
  });

  it('allows set() in read-only mode, since config is not the store', () => {
    const plugin = new ReadOnlyStubPlugin();
    plugin.set('clusterTopologyVariableName', 'MY_TOPOLOGY');

    expect(plugin.get('clusterTopologyVariableName')).toBe('MY_TOPOLOGY');
  });

  it('keeps base defaults for a read-only subclass that adds config', () => {
    const plugin = new RegionPlugin({ writable: false });

    expect(plugin.writable).toBe(false);
    expect(plugin.get('region')).toBe('us-east-1');
    expect(plugin.get('clusterTopologyVariableName')).toBe('__MONGODB_CLUSTER_TOPOLOGY');
  });
});

});
