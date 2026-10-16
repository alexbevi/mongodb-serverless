import { expect, test } from 'vitest';
import { executionRecorder } from '../execution.js';

test.skipIf(!process.threadCpuUsage)('partitions a cold operation into callback execution and measured dispatch waits', async () => {
  const recorder = executionRecorder();
  const start = recorder.start();

  await recorder.invoke(() => new Promise<void>(resolve => setTimeout(resolve, 20)));

  const trace = recorder.stop();
  expect(trace.start).toBe(start);
  expect(trace.segments[0]!.start).toBe(start);
  expect(trace.segments.at(-1)!.end).toBe(trace.end);

  for (let index = 1; index < trace.segments.length; index++) {
    expect(trace.segments[index]!.start).toBe(trace.segments[index - 1]!.end);
  }

  const waiting = trace.segments.filter(segment => segment.kind === 'dispatch' && segment.resource === 'Timeout');
  expect(waiting.reduce((total, segment) => total + segment.end - segment.start, 0)).toBeGreaterThan(10);
  expect(trace.segments.some(segment => segment.kind === 'callback' && segment.resource === 'Timeout')).toBe(true);
  expect(trace.threadCpuMs).toBeGreaterThanOrEqual(0);
  expect(trace.segments.every(segment => segment.source.length > 0)).toBe(true);
});
