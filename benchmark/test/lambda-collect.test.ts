import { expect, it } from 'vitest';

it('keeps handler REPORT duration distinct from INIT duration', async () => {
  const { invokeCold } = await import(new URL('../lambda-collect.mjs', import.meta.url).href);

  const lambda = { send: async () => ({
    Payload: Buffer.from(JSON.stringify({ verified: true, cold: true })),
    LogResult: Buffer.from('REPORT RequestId: example\tDuration: 42.50 ms\tBilled Duration: 643 ms\tInit Duration: 600.25 ms').toString('base64')
  }) };

  const result = await invokeCold(lambda, 'worker', '1', { variant: 'native', operation: 'read' });

  expect(result.lambda).toEqual({ version: '1', initMs: 600.25, initSource: 'lambda-report', durationMs: 42.5 });
});

it('requires warm calls to reuse the environment and socket without repeating setup', async () => {
  const { assertWarmReuse } = await import(new URL('../lambda-collect.mjs', import.meta.url).href);
  const cold = { cold: true, clientConstructions: 1, environmentId: 'one', trace: { command: { socket: { start: 10 } } } };

  const warm = { cold: false, clientConstructions: 1, monitorSockets: 0, verified: true, environmentId: 'one', sockets: 0, ssmReads: 0,
    ssmWrites: 0, discoveryCommands: 0, dns: [], trace: { start: 100, command: { start: 101, socket: { start: 10 } } } };

  expect(() => assertWarmReuse(cold, warm)).not.toThrow();

  for (const change of [{ environmentId: 'two' }, { sockets: 1 }, { ssmReads: 1 }, { ssmWrites: 1 }, { discoveryCommands: 1 }, { dns: ['SRV'] }, { cold: true }]) {
    expect(() => assertWarmReuse(cold, { ...warm, ...change })).toThrow();
  }

  expect(() => assertWarmReuse(cold, { ...warm, trace: { start: 100, command: { start: 101, socket: { start: 99 } } } })).toThrow();
  expect(() => assertWarmReuse(cold, { ...warm, trace: { start: 100, command: { start: 99, socket: { start: 10 } } } })).toThrow();
});

it('allows a retained native client to choose another member for a nearest read', async () => {
  const { assertWarmReuse } = await import(new URL('../lambda-collect.mjs', import.meta.url).href);
  const cold = { cold: true, environmentId: 'one', clientConstructions: 1, trace: { command: { socket: { start: 10 } } } };

  const warm = { variant: 'native', operation: 'read', cold: false, verified: true, environmentId: 'one',
    clientConstructions: 1, sockets: 1, authenticatedSockets: 1, monitorSockets: 0, ssmReads: 0, ssmWrites: 0,
    discoveryCommands: 0, dns: [], trace: { start: 100, command: { start: 120, socket: { start: 110 } } } };

  expect(() => assertWarmReuse(cold, warm)).not.toThrow();
  expect(() => assertWarmReuse(cold, { ...warm, clientConstructions: 2 })).toThrow();
  expect(() => assertWarmReuse(cold, { ...warm, monitorSockets: 3 })).toThrow();
});

it('uses a labelled process clock when LocalStack omits the INIT report', async () => {
  const { invokeCold } = await import(new URL('../lambda-collect.mjs', import.meta.url).href);

  const lambda = { send: async () => ({
    Payload: Buffer.from(JSON.stringify({ verified: true, cold: true, initialization: { processReadyMs: 310 } })),
    LogResult: Buffer.from('REPORT RequestId: example\tDuration: 42.50 ms').toString('base64')
  }) };

  const result = await invokeCold(lambda, 'worker', '1', { variant: 'native', operation: 'read' });

  expect(result.lambda.initMs).toBe(310);
  expect(result.lambda.initSource).toBe('node-process-clock');
  expect(result.lambda.durationMs).toBe(42.5);
});

it('clears only the uncached topology parameters before each cold round', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { collect, workerPatterns } = await import(new URL('../lambda-collect.mjs', import.meta.url).href);
  const directory = await mkdtemp(join(tmpdir(), 'lambda-cache-miss-'));
  const events: string[] = [];
  let version = 0;
  const prefix = 'test-pattern';

  const ssm = { send: async (command: { input: { Names: string[] } }) => {
    expect(command.input.Names).toEqual([`/${prefix}/topology-miss-read`, `/${prefix}/topology-miss-write`]);
    events.push('clear');

    return {};
  } };

  const lambda = { send: async (command: { constructor: { name: string }; input: { Payload?: Uint8Array; FunctionName: string; Qualifier?: string } }) => {
    const name = command.constructor.name;

    if (name === 'GetFunctionConfigurationCommand') return { Environment: { Variables: {} } };

    if (name === 'GetFunctionCommand') return { Configuration: { LastUpdateStatus: 'Successful', State: 'Active' } };

    if (name === 'PublishVersionCommand') {
      events.push('publish');

      return { Version: String(++version) };
    }

    if (name === 'InvokeCommand') {
      const event = JSON.parse(Buffer.from(command.input.Payload!).toString());
      events.push('invoke');

      return { Payload: Buffer.from(JSON.stringify({ ...event, verified: true, cold: true, totalMs: 1,
        environmentId: `${command.input.FunctionName}:${command.input.Qualifier}`, trace: {} })) };
    }

    return {};
  } };

  try {
    expect(workerPatterns(prefix)).toHaveLength(8);
    await collect(lambda, ssm, prefix, 2, join(directory, 'samples.json'), { diagnostics: false });
    const data = JSON.parse(await readFile(join(directory, 'samples.json'), 'utf8'));
    expect(data.samples).toHaveLength(16);
    expect(data.configuration.variants).toEqual(['native', 'no-plugin', 'ssm', 'ssm-uncached']);
    expect(events).toEqual(Array.from({ length: 2 }, () => ['clear', ...Array(8).fill('publish'), ...Array(8).fill('invoke')]).flat());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
