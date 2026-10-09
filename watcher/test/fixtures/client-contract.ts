import { MongoClient } from 'mongodb';
import type { ClientFactory } from '../../src/cluster.js';

const fake = {
  async connect() {
    return this;
  },
  db() {
    return { command: async () => ({ ok: 1 }) };
  },
  async close() {},
};

const factory: ClientFactory = () => fake;

const realFactory: ClientFactory = uri => new MongoClient(uri);

// @ts-expect-error Every injected client must connect before commands are sent.
const missingConnect: ClientFactory = () => ({ db: fake.db, close: fake.close });

void [factory, realFactory, missingConnect];
