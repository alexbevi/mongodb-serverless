import { expect, test } from 'vitest';
import { activities } from '../activities.js';
import { measureAwsOperation } from '../aws-diagnostics.js';

test.skipIf(!process.threadCpuUsage)('captures an AWS operation with continuous execution and measured scopes', async () => {
  const measured = await measureAwsOperation(async () => {
    activities.sync('Native URI/options parsing', () => JSON.parse('{"value":42}'));
    await new Promise(resolve => setTimeout(resolve, 5));

    return 42;
  });

  expect(measured.result).toBe(42);
  expect(measured.activities.some(span => span.name === 'Native URI/options parsing')).toBe(true);
  expect(measured.activities.some(span => span.name === 'Trace stack capture')).toBe(true);
  expect(measured.execution.threadCpuMs).toBeGreaterThan(0);
  let boundary = measured.start;

  for (const segment of measured.execution.segments) {
    expect(segment.start).toBe(boundary);
    expect(segment.end).toBeGreaterThanOrEqual(segment.start);
    boundary = segment.end;
  }

  expect(boundary).toBe(measured.end);
  await expect(measureAwsOperation(async () => { throw new Error('operation failed'); })).rejects.toThrow('operation failed');
  const next = await measureAwsOperation(async () => 'next operation');
  expect(next.result).toBe('next operation');
  expect(next.execution.start).toBeGreaterThan(measured.end);
});

test('measures protocol-only operations without execution or activity probes', async () => {
  const { measureProtocolOperation } = await import('../aws-diagnostics.js');
  activities.start();
  activities.stop(performance.now());

  const measured = await measureProtocolOperation(async () => {
    activities.sync('Native URI/options parsing', () => JSON.parse('{"value":42}'));
    await new Promise(resolve => setTimeout(resolve, 5));

    return 42;
  });

  expect(measured.result).toBe(42);
  expect(measured.end - measured.start).toBeGreaterThanOrEqual(4);
  expect(measured).not.toHaveProperty('execution');
  expect(measured).not.toHaveProperty('activities');
  expect(activities.stop(measured.end)).toEqual([]);
  await expect(measureProtocolOperation(async () => { throw new Error('operation failed'); })).rejects.toThrow('operation failed');
});
