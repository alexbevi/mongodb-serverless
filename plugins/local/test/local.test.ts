import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalPlugin } from '../src/index.js';

const VAR = '__MONGODB_CLUSTER_TOPOLOGY';

const status = {
  set: 'rs0',
  members: [
    { name: 'localhost:27017', stateStr: 'PRIMARY', health: 1 },
    { name: 'localhost:27018', stateStr: 'SECONDARY', health: 1 }
  ]
};

describe('LocalPlugin', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = { ...process.env };
  });

  afterEach(() => {
    process.env = env;
  });

  it('reports its static details', () => {
    const plugin = new LocalPlugin();

    expect(plugin.name).toBe('Local Environment');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.author).toBeTypeOf('string');
  });

  it('reads topology from the default variable', async () => {
    process.env[VAR] = JSON.stringify(status);

    await expect(new LocalPlugin().read()).resolves.toEqual(status);
  });

  it('reads topology from an overridden variable', async () => {
    process.env['MY_TOPOLOGY'] = JSON.stringify(status);
    const plugin = new LocalPlugin();
    plugin.set('clusterTopologyVariableName', 'MY_TOPOLOGY');

    await expect(plugin.read()).resolves.toEqual(status);
  });

  it('writes topology back to the variable', async () => {
    const plugin = new LocalPlugin();
    await plugin.write(status);

    expect(JSON.parse(process.env[VAR] as string)).toEqual(status);
  });

  it('round-trips a write through a read', async () => {
    const plugin = new LocalPlugin();
    await plugin.write(status);

    await expect(plugin.read()).resolves.toEqual(status);
  });

  it('fails verify when the variable is unset, naming it', async () => {
    delete process.env[VAR];

    await expect(new LocalPlugin().verify()).rejects.toThrow(new RegExp(VAR));
  });

  it('fails verify when the value is not JSON', async () => {
    process.env[VAR] = 'not json';

    await expect(new LocalPlugin().verify()).rejects.toThrow(/JSON/i);
  });

  it('fails verify when the document has no members array', async () => {
    process.env[VAR] = JSON.stringify({ set: 'rs0' });

    await expect(new LocalPlugin().verify()).rejects.toThrow(/members/);
  });

  it('passes verify on a well-formed document', async () => {
    process.env[VAR] = JSON.stringify(status);

    await expect(new LocalPlugin().verify()).resolves.toBeUndefined();
  });

  it('fails read when the variable is unset', async () => {
    delete process.env[VAR];

    await expect(new LocalPlugin().read()).rejects.toThrow(new RegExp(VAR));
  });

  it('setup leaves an already-valid environment alone', async () => {
    process.env[VAR] = JSON.stringify(status);
    const plugin = new LocalPlugin();
    await plugin.setup();

    await expect(plugin.read()).resolves.toEqual(status);
  });
});
