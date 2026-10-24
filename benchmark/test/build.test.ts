import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

test('declares the connection string parser imported by benchmark instrumentation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  expect(manifest.devDependencies['mongodb-connection-string-url']).toBeDefined();
});

test('npm benchmark compiles the worker before validating arguments', () => {
  const result = spawnSync('npm', ['run', 'benchmark', '--', '--samples', '0'], { encoding: 'utf8' });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/--samples must be a positive integer/);
  expect(existsSync('benchmark/dist/cold.js')).toBe(true);
}, 30_000);

test('does not impose an artificial CPU quota on local benchmarks', () => {
  const compose = readFileSync(new URL('../docker/compose.yaml', import.meta.url), 'utf8');

  expect(compose).not.toMatch(/cpus:|cpu_quota:|cpu_period:/);
});
