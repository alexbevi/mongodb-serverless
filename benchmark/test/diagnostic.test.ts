import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { executionRecorder } from '../execution.js';
import type { Activity } from '../activities.js';

test('records code scopes and continuous execution evidence against the real replica set', () => {
  const output = join(mkdtempSync(join(tmpdir(), 'mongo-diagnostic-')), 'samples.json');
  execFileSync('node', ['benchmark/dist/run.js', '--diagnostics', '--no-monitoring', '--samples', '1', '--output', output], { timeout: 580_000 });
  const result: { samples: { verified: boolean; trace: { start: number; end: number; activities: Activity[]; execution: ReturnType<ReturnType<typeof executionRecorder>['stop']> } }[] } = JSON.parse(readFileSync(output, 'utf8'));
  expect(result.samples).toHaveLength(6);

  for (const sample of result.samples) {
    expect(sample.verified).toBe(true);
    expect(sample.trace.execution.start).toBe(sample.trace.start);
    expect(sample.trace.execution.end).toBe(sample.trace.end);
    expect(sample.trace.activities.some(span => span.name === 'Native URI/options parsing')).toBe(true);
    expect(sample.trace.activities.some(span => span.name === 'Read TLS CA certificate')).toBe(true);
    let boundary = sample.trace.start;

    for (const segment of sample.trace.execution.segments) {
      expect(segment.start).toBe(boundary);
      expect(segment.end).toBeGreaterThanOrEqual(segment.start);
      boundary = segment.end;
    }

    expect(boundary).toBe(sample.trace.end);
  }
}, 600_000);
