import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

describe('workspace', () => {
  it('declares every package in the pnpm workspace', () => {
    const workspace = read('pnpm-workspace.yaml');

    expect(workspace).toContain('driver');
    expect(workspace).toContain('watcher');
    expect(workspace).toContain('plugins/*');
  });

  it('resolves the peer mongodb driver the wrapper is built against', async () => {
    const { MongoClient } = await import('mongodb');

    expect(typeof MongoClient).toBe('function');
  });

  it('gives every workspace package a README', () => {
    for (const path of [
      'README.md',
      'driver/README.md',
      'watcher/README.md',
      'plugins/base/README.md',
      'plugins/local/README.md'
    ]) {
      expect(read(path).length, path).toBeGreaterThan(0);
    }
  });
});
