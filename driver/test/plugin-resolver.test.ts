import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDefaultPlugin,
  resolvePlugin,
  setDefaultPlugin,
  validatePlugin
} from '../src/plugin-resolver.js';
import { InvalidPluginError, MissingPluginError, PluginNotInstalledError } from '../src/errors.js';
import type { ReplSetGetStatus, TopologyPlugin } from '../src/plugin.js';

const status: ReplSetGetStatus = { set: 'rs0', members: [] };

const stub = (name = 'stub'): TopologyPlugin => ({
  name,
  version: '1.0.0',
  author: 'test',
  setup: async () => {},
  verify: async () => {},
  read: async () => status,
  write: async () => {}
});

const fixture = (dir: string): string => new URL(`./fixtures/${dir}/index.ts`, import.meta.url).href;

afterEach(() => {
  clearDefaultPlugin();
});

describe('resolvePlugin', () => {
  it('passes an instance through', async () => {
    const plugin = stub();

    await expect(resolvePlugin(plugin)).resolves.toBe(plugin);
  });

  it('imports and constructs a plugin named by specifier', async () => {
    const plugin = await resolvePlugin(fixture('plugin-good'));

    expect(plugin.name).toBe('third-party');
  });

  it('accepts a plugin that does not extend the base class', async () => {
    // Structural validation is what makes a third-party plugin possible. The
    // fixture extends nothing, and its prototype chain reaches only Object.
    const plugin = await resolvePlugin(fixture('plugin-good'));
    const base = Object.getPrototypeOf(Object.getPrototypeOf(plugin));

    expect(base).toBe(Object.prototype);
    await expect(plugin.read()).resolves.toHaveProperty('members');
  });

  it('falls back to the default plugin', async () => {
    const plugin = stub('default');
    setDefaultPlugin(plugin);

    await expect(resolvePlugin()).resolves.toBe(plugin);
  });

  it('prefers an explicit plugin over the default', async () => {
    setDefaultPlugin(stub('default'));
    const explicit = stub('explicit');

    await expect(resolvePlugin(explicit)).resolves.toBe(explicit);
  });

  it('resolves a default given as a specifier', async () => {
    setDefaultPlugin(fixture('plugin-good'));

    await expect(resolvePlugin()).resolves.toHaveProperty('name', 'third-party');
  });

  it('throws MissingPluginError when nothing is supplied', async () => {
    await expect(resolvePlugin()).rejects.toThrow(MissingPluginError);
  });

  it('names both mechanisms in the missing-plugin message', async () => {
    await expect(resolvePlugin()).rejects.toThrow(/setDefaultPlugin/);
  });

  it('throws PluginNotInstalledError for an unresolvable specifier', async () => {
    await expect(resolvePlugin('@mongodb-serverless/plugin-nope')).rejects.toThrow(
      PluginNotInstalledError
    );
  });

  it('names the specifier and how to install it', async () => {
    await expect(resolvePlugin('@mongodb-serverless/plugin-nope')).rejects.toThrow(
      /@mongodb-serverless\/plugin-nope/
    );
  });

  it("propagates a failure from inside the plugin's own imports", async () => {
    // Reporting this as not-installed would send the user hunting the wrong bug.
    const attempt = resolvePlugin(fixture('plugin-broken'));

    await expect(attempt).rejects.toThrow();
    await expect(attempt).rejects.not.toThrow(PluginNotInstalledError);
  });

  it('throws InvalidPluginError for a module missing members', async () => {
    await expect(resolvePlugin(fixture('plugin-incomplete'))).rejects.toThrow(InvalidPluginError);
  });

  it('names every missing member', async () => {
    const attempt = resolvePlugin(fixture('plugin-incomplete'));

    await expect(attempt).rejects.toThrow(/read/);
    await expect(attempt).rejects.toThrow(/author/);
  });
});

describe('validatePlugin', () => {
  it('accepts a complete plugin', () => {
    expect(() => validatePlugin(stub(), 'test')).not.toThrow();
  });

  it('accepts a plugin built against a duplicate copy of the base class', () => {
    // instanceof fails across two installed copies of plugin-base. Structural
    // validation is the only check that survives it.
    class BaseCopyOne {
      async setup(): Promise<void> {}
      async verify(): Promise<void> {}
      async read(): Promise<ReplSetGetStatus> {
        return status;
      }
      async write(): Promise<void> {}
    }
    class BaseCopyTwo extends BaseCopyOne {}

    class Plugin extends BaseCopyTwo {
      readonly name = 'dupe';
      readonly version = '1.0.0';
      readonly author = 'test';
    }

    const plugin = new Plugin();

    expect(plugin instanceof BaseCopyOne).toBe(true);
    expect(() => validatePlugin(plugin, 'test')).not.toThrow();
  });

  it('finds methods inherited from a prototype', () => {
    class Base {
      async setup(): Promise<void> {}
      async verify(): Promise<void> {}
      async read(): Promise<ReplSetGetStatus> {
        return status;
      }
      async write(): Promise<void> {}
    }
    const plugin = Object.assign(new Base(), {
      name: 'inherited',
      version: '1.0.0',
      author: 'test'
    });

    expect(() => validatePlugin(plugin, 'test')).not.toThrow();
  });

  it.each([null, undefined, 42, 'string'])('rejects %s', value => {
    expect(() => validatePlugin(value, 'test')).toThrow(InvalidPluginError);
  });

  it('names a missing method', () => {
    const { read: _read, ...rest } = stub();

    expect(() => validatePlugin(rest, 'test')).toThrow(/read/);
  });

  it('names a non-string detail', () => {
    expect(() => validatePlugin({ ...stub(), version: 7 }, 'test')).toThrow(/version/);
  });

  it('includes the source in the message', () => {
    expect(() => validatePlugin({}, '@scope/my-plugin')).toThrow(/@scope\/my-plugin/);
  });
});
