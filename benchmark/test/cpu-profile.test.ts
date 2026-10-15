import { expect, test } from 'vitest';
import { startCpuProfile } from '../cpu-profile.js';

test('captures executing functions during the measured operation', async () => {
  const stop = await startCpuProfile();

  function benchmarkBusyCallback() {
    const end = performance.now() + 30;

    while (performance.now() < end) Math.sqrt(Math.random());
  }

  benchmarkBusyCallback();
  const result = await stop();
  expect(result.profile.nodes.some(node => node.callFrame.functionName === 'benchmarkBusyCallback')).toBe(true);
  expect(result.profile.samples!.length).toBeGreaterThan(0);
  expect(result.origin).toBeLessThan(performance.now());
});
