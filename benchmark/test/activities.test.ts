import { expect, test } from 'vitest';
import { activityRecorder } from '../activities.js';

test('records nested synchronous work and pending async scopes without changing promise identity', async () => {
  let now = 0;
  const recorder = activityRecorder(() => now, () => now);
  let finish!: (value: number) => void;
  const pending = new Promise<number>(resolve => { finish = resolve; });
  recorder.start();
  const returned = recorder.async('Load patch', () => recorder.sync('Prepare import', () => {
    now = 2;
    return pending;
  }));
  expect(returned).toBe(pending);
  now = 5;
  finish(7);
  expect(await returned).toBe(7);
  expect(recorder.stop(6)).toEqual([
    { name: 'Prepare import', kind: 'sync', start: 0, end: 2, threadCpuMs: expect.any(Number) },
    { name: 'Load patch', kind: 'async', start: 0, end: 5 }
  ]);
});

test('separates synchronous scope elapsed time from thread CPU time', () => {
  let wall = 0;
  let cpu = 0;
  const recorder = activityRecorder(() => wall, () => cpu);
  recorder.start();
  recorder.sync('Client construction', () => { wall = 50; cpu = 2; });
  expect(recorder.stop(50)).toEqual([
    { name: 'Client construction', kind: 'sync', start: 0, end: 50, threadCpuMs: 2 }
  ]);
});
