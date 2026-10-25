import { expect, it, vi } from 'vitest';
import { ServerlessMongoClient } from '../src/client.js';
import type { TopologyPlugin } from '../src/plugin.js';

function lookupPlugin(getConnectionString: () => Promise<string>): TopologyPlugin {
  return {
    name: 'lookup', version: '1', author: 'test',
    async setup() {}, async verify() {}, async read() { return null; }, async write() {},
    getConnectionString
  };
}

it('closes an unused client without looking up its connection string', async () => {
  const getConnectionString = vi.fn(async () => { throw new Error('SSM unavailable'); });
  const client = new ServerlessMongoClient(lookupPlugin(getConnectionString));

  await expect(client.close()).resolves.toBeUndefined();
  expect(getConnectionString).not.toHaveBeenCalled();
});

it('rejects use after close instead of reconnecting', async () => {
  const getConnectionString = vi.fn(async () => 'mongodb://a:27017/');
  const client = new ServerlessMongoClient(lookupPlugin(getConnectionString));
  await client.close();

  await expect(client.connect()).rejects.toThrow(/closed/i);
  await expect(client.db('app').collection('c').findOne({})).rejects.toThrow(/closed/i);
  expect(getConnectionString).not.toHaveBeenCalled();
});

it('can be closed more than once', async () => {
  const client = new ServerlessMongoClient('mongodb://a:27017/');

  await client.close();
  await expect(client.close()).resolves.toBeUndefined();
});
