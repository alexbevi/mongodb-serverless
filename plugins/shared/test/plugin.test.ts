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

class WritableStubPlugin extends StubPlugin {
  constructor() {
    super({ writable: true });
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
  it('defaults refreshIntervalMS to 10000', () => {
    expect(new StubPlugin().get('refreshIntervalMS')).toBe(10_000);
  });

  it('defaults clusterTopologyVariableName to __MONGODB_CLUSTER_TOPOLOGY', () => {
    expect(new StubPlugin().get('clusterTopologyVariableName')).toBe('__MONGODB_CLUSTER_TOPOLOGY');
  });

  it('round-trips a value through set and get', () => {
    const plugin = new StubPlugin();
    plugin.set('refreshIntervalMS', 500);

    expect(plugin.get('refreshIntervalMS')).toBe(500);
  });

  it('keeps config per instance', () => {
    const one = new StubPlugin();
    const two = new StubPlugin();
    one.set('refreshIntervalMS', 500);

    expect(two.get('refreshIntervalMS')).toBe(10_000);
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
    expect(plugin.get('refreshIntervalMS')).toBe(10_000);
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
  it('is read-only by default', () => {
    expect(new StubPlugin().writable).toBe(false);
  });

  it('is writable when constructed writable', () => {
    expect(new WritableStubPlugin().writable).toBe(true);
  });

  it('throws PluginReadOnlyError from assertWritable when read-only', () => {
    expect(() => new StubPlugin().guard()).toThrow(PluginReadOnlyError);
  });

  it('names the plugin in the error', () => {
    expect(() => new StubPlugin().guard()).toThrow(/stub/);
  });

  it('permits assertWritable when writable', () => {
    expect(() => new WritableStubPlugin().guard()).not.toThrow();
  });

  it('allows set() in read-only mode, since config is not the store', () => {
    const plugin = new StubPlugin();
    plugin.set('refreshIntervalMS', 500);

    expect(plugin.get('refreshIntervalMS')).toBe(500);
  });

  it('keeps base defaults for a subclass that adds config and asks to write', () => {
    const plugin = new RegionPlugin({ writable: true });

    expect(plugin.writable).toBe(true);
    expect(plugin.get('region')).toBe('us-east-1');
    expect(plugin.get('refreshIntervalMS')).toBe(10_000);
  });
});

});
