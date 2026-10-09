import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

test('declares the connection string parser imported by benchmark instrumentation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  expect(manifest.devDependencies['mongodb-connection-string-url']).toBeDefined();
});

test('npm benchmark compiles the harness before validating arguments', () => {
  const result = spawnSync('npm', ['run', 'benchmark', '--', '--samples', '0'], { encoding: 'utf8' });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/--samples must be an integer/);
  expect(existsSync('benchmark/dist/run.js')).toBe(true);
}, 30_000);
