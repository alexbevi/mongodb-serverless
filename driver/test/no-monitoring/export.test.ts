import { createRequire } from 'node:module';
import { MongoClient } from 'mongodb';
import { expect, it } from 'vitest';

it('exports the helper through the package subpath', () => {
  const require = createRequire(import.meta.url);
  const module: { disableMonitoring<T extends MongoClient>(client: T): T } = require('@mongodb-serverless/driver/no-monitoring');
  const client = new MongoClient('mongodb://localhost:28017', { directConnection: true });
  expect(module.disableMonitoring(client)).toBe(client);
});
