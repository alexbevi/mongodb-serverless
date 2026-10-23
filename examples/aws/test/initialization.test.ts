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

  await expect(loadConnectionString('/example/uri', send)).resolves.toBe('mongodb+srv://example.test/app');
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

    return 'mongodb://example.test/app';
  });

  const create = vi.fn(() => {
    order.push('client');

    return collectionInstance;
  });

  const run = await initializeParameterCollection(load, create);

  expect(order).toEqual(['parameter']);
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance });
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance });
  expect(order).toEqual(['parameter', 'client']);
  expect(create).toHaveBeenCalledOnce();
});

it('loads plugin settings eagerly but creates and retains the client lazily', async () => {
  const order: string[] = [];
  const collectionInstance = exampleCollection();

  const verify = vi.fn(async () => { order.push('plugin'); });

  const create = vi.fn(() => {
    order.push('client');

    return collectionInstance;
  });

  const run = await initializePluginCollection(verify, create);

  expect(order).toEqual(['plugin']);
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance });
  await expect(run(async collection => collection)).resolves.toMatchObject({ result: collectionInstance });
  expect(order).toEqual(['plugin', 'client']);
  expect(create).toHaveBeenCalledOnce();
});
