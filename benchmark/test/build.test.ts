import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('npm benchmark compiles the harness before validating arguments', () => {
  const result = spawnSync('npm', ['run', 'benchmark', '--', '--samples', '0'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--samples must be an integer/);
  assert.ok(existsSync('benchmark/dist/run.js'), 'The npm entry point must emit the benchmark runner');
});
