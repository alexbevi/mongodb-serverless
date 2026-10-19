import { expect, it } from 'vitest';

it('keeps handler REPORT duration distinct from INIT duration', async () => {
  const { invokeCold } = await import(new URL('../lambda-collect.mjs', import.meta.url).href);
  const lambda = { send: async () => ({
    Payload: Buffer.from(JSON.stringify({ verified: true, cold: true })),
    LogResult: Buffer.from('REPORT RequestId: example\tDuration: 42.50 ms\tBilled Duration: 643 ms\tInit Duration: 600.25 ms').toString('base64')
  }) };
  const result = await invokeCold(lambda, 'worker', '1', { variant: 'native', operation: 'read' });

  expect(result.lambda).toEqual({ version: '1', initMs: 600.25, durationMs: 42.5 });
});
