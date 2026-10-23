import { expect, it, vi } from 'vitest';
import { GetParameterCommand, type GetParameterCommandOutput } from '@aws-sdk/client-ssm';
import { loadConnectionString } from '../src/connection-string.js';
import { initializeParameterCollection, initializePluginCollection } from '../src/initialization.js';

function exampleCollection() {
  return { findOne: vi.fn(), updateOne: vi.fn() };
}

it('decrypts a SecureString connection parameter', async () => {
  const send = vi.fn(async (command: GetParameterCommand): Promise<Pick<GetParameterCommandOutput, 'Parameter'>> => {
    expect(command.input).toEqual({ Name: '/example/uri', WithDecryption: true });

    return { Parameter: { Type: 'SecureString', Value: 'mongodb+srv://example.test/app' } };
  });

  await expect(loadConnectionString('/example/uri', send)).resolves.toEqual({
    connectionString: 'mongodb+srv://example.test/app',
    ssmMs: expect.any(Number)
  });
  expect(send).toHaveBeenCalledOnce();
});

it('rejects missing or non-secret connection settings', async () => {
  const send = vi.fn(async (): Promise<Pick<GetParameterCommandOutput, 'Parameter'>> => ({
    Parameter: { Type: 'String', Value: 'mongodb://example.test/app' }
  }));

  await expect(loadConnectionString('/example/uri', send)).rejects.toThrow('must contain a SecureString');
});

it('loads the parameter eagerly but creates and retains the client lazily', async () => {
  const order: string[] = [];
  const collectionInstance = exampleCollection();

  const load = vi.fn(async () => {
    order.push('parameter');

    return { connectionString: 'mongodb://example.test/app', ssmMs: 12 };
  });

  const create = vi.fn(() => {
    order.push('client');

    return collectionInstance;
  });

  const close = vi.fn(async () => { order.push('close'); });

  const run = await initializeParameterCollection(load, create, close);

  expect(order).toEqual(['parameter']);
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance, ssmMs: 12 });
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance });
  expect(order).toEqual(['parameter', 'client']);
  expect(create).toHaveBeenCalledOnce();

  await run.close();
  await run(async collection => collection);
  expect(order).toEqual(['parameter', 'client', 'close', 'client']);
  expect(create).toHaveBeenCalledTimes(2);
});

it('loads plugin settings eagerly but creates and retains the client lazily', async () => {
  const order: string[] = [];
  const collectionInstance = exampleCollection();

  const verify = vi.fn(async () => {
    order.push('plugin');

    return 14;
  });

  const create = vi.fn(() => {
    order.push('client');

    return collectionInstance;
  });

  const close = vi.fn(async () => { order.push('close'); });

  const run = await initializePluginCollection(verify, create, close);

  expect(order).toEqual(['plugin']);
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance, ssmMs: 14 });
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance });
  expect(order).toEqual(['plugin', 'client']);
  expect(create).toHaveBeenCalledOnce();

  await run.close();
  await run(async collection => collection);
  expect(order).toEqual(['plugin', 'client', 'close', 'client']);
  expect(create).toHaveBeenCalledTimes(2);
});
