import { describe, expect, it } from 'vitest';
import { ServerlessPlugin, type PluginConfig } from '../src/index.js';
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
}

interface RegionConfig extends PluginConfig {
  region: string;
}

class RegionPlugin extends ServerlessPlugin<RegionConfig> {
  readonly name = 'region';
  readonly version = '1.0.0';
  readonly author = 'test';

  constructor() {
    super({ region: 'us-east-1' });
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

    expect(() => plugin.set('nope' as keyof PluginConfig, 1 as never)).toThrow(/nope/);
  });

  it('rejects an unknown key on get', () => {
    const plugin = new StubPlugin();

    expect(() => plugin.get('nope' as keyof PluginConfig)).toThrow(/nope/);
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
});
