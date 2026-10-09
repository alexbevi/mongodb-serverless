import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('Oxlint rejects unknown parameters and accepts a concrete parameter', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anti-slop-'));
  const fixture = join(directory, 'example.ts');

  try {
    for (const type of ['unknown', 'string']) {
      writeFileSync(fixture, `export function inspect(value: ${type}): boolean {\n  return Boolean(value);\n}\n`);

      const result = spawnSync(process.execPath, [
        join(root, 'node_modules/oxlint/bin/oxlint'),
        '--config', join(root, '.oxlintrc.json'),
        '--format', 'json', fixture,
      ], { cwd: root, encoding: 'utf8' });

      assert.ifError(result.error);
      assert.equal(result.status, type === 'unknown' ? 1 : 0, result.stdout + result.stderr);

      const { diagnostics } = JSON.parse(result.stdout);

      assert.equal(diagnostics.length, type === 'unknown' ? 1 : 0);

      if (type === 'unknown') {
        assert.equal(diagnostics[0].code, 'anti-slop(no-unknown-parameters)');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
