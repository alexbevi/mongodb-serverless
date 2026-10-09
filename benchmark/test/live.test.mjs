import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('compares fresh clients against a delayed TLS replica set with SCRAM authentication', { timeout: 600_000 }, () => {
  const output = join(mkdtempSync(join(tmpdir(), 'mongo-benchmark-')), 'results.json');
  execFileSync(process.execPath, ['benchmark/run.mjs', '--samples', '1', '--output', output], { stdio: 'inherit', timeout: 580_000 });
  const result = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.samples.length, 4);
  for (const sample of result.samples) {
    assert.ok(sample.verified);
    for (const phase of ['tcp', 'tls', 'hello', 'auth', 'send', 'receive']) assert.ok(sample.timings[phase] > 0, phase);
    assert.ok(sample.timings.other >= 0);
    assert.equal(sample.driverVersion, '7.7.0');
    assert.match(sample.address, /172\.30\.91\.11:27017/);
  }
  assert.equal(new Set(result.samples.map(s => s.processId)).size, 4);
  assert.equal(result.network.length, 12);
  assert.ok(result.network.every(link => link.measuredRttMs >= link.configuredRttMs * 0.8));
});
