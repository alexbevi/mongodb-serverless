import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);

const resolve = (path: string): string => fileURLToPath(new URL(path, root));

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

describe('workspace', () => {
  it('allows the esbuild installation script used by the test runner', () => {
    expect(read('pnpm-workspace.yaml')).toMatch(/allowBuilds:\s*\n\s+esbuild: true/);
  });

  it('selects a pnpm version for both CI and trusted publishing', () => {
    const versions = ['ci', 'release'].map(workflow => {
      const config = read(`.github/workflows/${workflow}.yml`);

      const version = config.match(
        /uses: pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: ['"]?(\d+\.\d+\.\d+)/
      )?.[1];

      expect(version, `${workflow} must select pnpm explicitly`).toBeDefined();
      expect(Number(version?.split('.')[0])).toBeGreaterThanOrEqual(12);

      return version;
    });

    expect(versions[0]).toBe(versions[1]);
  });

  it('selects both packages with the integration command', () => {
    const { scripts } = JSON.parse(read('package.json'));
    const args = scripts['test:integration'].split('vitest run ')[1].split(/\s+/);

    const files = execFileSync(
      process.execPath,
      [resolve('node_modules/vitest/vitest.mjs'), 'list', ...args, '--filesOnly'],
      { cwd: resolve('.'), encoding: 'utf8' }
    );

    expect(files).toContain('driver/test/integration.test.ts');
    expect(files).toContain('watcher/test/integration.test.ts');
  });

  it('declares every publishable package', () => {
    const workspace = read('pnpm-workspace.yaml');

    expect(workspace).toContain('driver');
    expect(workspace).toContain('watcher');
    expect(workspace).toContain('plugins/local');
  });

  it('resolves the peer mongodb driver the wrapper is built against', async () => {
    const { MongoClient } = await import('mongodb');

    expect(typeof MongoClient).toBe('function');
  });

  it('documents the repo, every package, and the plugin strategy', () => {
    for (const path of [
      'README.md',
      'driver/README.md',
      'watcher/README.md',
      'plugins/README.md',
      'plugins/shared/README.md',
      'plugins/local/README.md'
    ]) {
      expect(read(path).length, path).toBeGreaterThan(0);
    }
  });

  describe('the shared plugin contract', () => {
    it('is not a package', () => {
      // It compiles into each plugin instead of being published, so a plugin
      // never resolves it at runtime and it needs no release of its own.
      expect(existsSync(resolve('plugins/shared/package.json'))).toBe(false);
    });

    it('is excluded from the pnpm workspace', () => {
      expect(read('pnpm-workspace.yaml')).not.toContain('plugins/*');
    });
  });

  describe('plugin-local', () => {
    const pkg = (): Record<string, unknown> =>
      JSON.parse(read('plugins/local/package.json')) as Record<string, unknown>;

    it('depends on no workspace package', () => {
      // A `workspace:*` dependency makes the published tarball uninstallable
      // with npm, which fails with EUNSUPPORTEDPROTOCOL.
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = (pkg()[field] as Record<string, string>) ?? {};
        expect(Object.values(deps).filter(v => v.startsWith('workspace:')), field).toEqual([]);
      }
    });

    it('declares no plugin package as a dependency', () => {
      const deps = (pkg()['dependencies'] as Record<string, string>) ?? {};

      expect(Object.keys(deps).filter(n => n.includes('plugin-'))).toEqual([]);
    });
  });
});
