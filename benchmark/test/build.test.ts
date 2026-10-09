import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('npm benchmark compiles the harness before validating arguments', () => {
  const result = spawnSync('npm', ['run', 'benchmark', '--', '--samples', '0'], { encoding: 'utf8' });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/--samples must be an integer/);
  expect(existsSync('benchmark/dist/run.js')).toBe(true);
}, 30_000);
