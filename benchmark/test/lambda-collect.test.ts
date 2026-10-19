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

it('requires warm calls to reuse the environment and socket without repeating setup', async () => {
  const { assertWarmReuse } = await import(new URL('../lambda-collect.mjs', import.meta.url).href);
  const cold = { cold: true, environmentId: 'one', trace: { command: { socket: { start: 10 } } } };
  const warm = { cold: false, verified: true, environmentId: 'one', sockets: 0, ssmReads: 0,
    ssmWrites: 0, discoveryCommands: 0, dns: [], trace: { start: 100, command: { start: 101, socket: { start: 10 } } } };

  expect(() => assertWarmReuse(cold, warm)).not.toThrow();

  for (const change of [{ environmentId: 'two' }, { sockets: 1 }, { ssmReads: 1 }, { ssmWrites: 1 }, { discoveryCommands: 1 }, { dns: ['SRV'] }, { cold: true }]) {
    expect(() => assertWarmReuse(cold, { ...warm, ...change })).toThrow();
  }

  expect(() => assertWarmReuse(cold, { ...warm, trace: { start: 100, command: { start: 101, socket: { start: 99 } } } })).toThrow();
  expect(() => assertWarmReuse(cold, { ...warm, trace: { start: 100, command: { start: 99, socket: { start: 10 } } } })).toThrow();
});
