import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';

test.each(['native', 'serverless', 'serverless-no-monitoring'])('%s handlers create clients lazily and reuse them for warm calls', variant => {
  for (const operation of ['read', 'write']) {
    const result = spawnSync('node', ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { MongoClient } from 'mongodb';
      delete process.env.BENCHMARK_VARIANT;
      const { handler } = await import('./benchmark/dist/handler-${operation}.js');
      const { closeBenchmarkClients } = await import('./benchmark/dist/handler-base.js');
      process.env.BENCHMARK_VARIANT = '${variant}';
      process.env.__MONGODB_CLUSTER_TOPOLOGY = JSON.stringify({
        set: 'test', members: [
          { name: 'localhost:27017', stateStr: 'PRIMARY', health: 1 },
          { name: 'localhost:27018', stateStr: 'SECONDARY', health: 1 }
        ]
      });
      const clients = new Set();
      const originalDb = MongoClient.prototype.db;
      MongoClient.prototype.connect = async function () { return this; };
      MongoClient.prototype.db = function (...args) {
        clients.add(this);
        const database = originalDb.apply(this, args);
        const originalCollection = database.collection.bind(database);
        database.collection = (...args) => {
          const collection = originalCollection(...args);
          collection.findOne = async () => ({ _id: 'seed', payload: 'benchmark' });
          collection.updateOne = async () => ({ acknowledged: true, matchedCount: 1 });
          return collection;
        };
        return database;
      };
      try {
        const first = await handler();
        const second = await handler();
        assert.deepEqual(first, second);
        assert.equal(clients.size, 1, 'Warm invocation must reuse its client');
        assert.equal('${operation}' === 'read' ? first.payload : first.matchedCount,
          '${operation}' === 'read' ? 'benchmark' : 1);
      } finally {
        await closeBenchmarkClients();
      }
    `], { encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
});
