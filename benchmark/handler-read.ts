import type { MongoClient } from 'mongodb';
import type { MongoClient as ServerlessMongoClient } from '../driver/dist/driver/src/index.js';
import { createServerlessMongoClientForBenchmark, type BenchmarkDocument } from './handler-base.js';

let client: MongoClient | ServerlessMongoClient | undefined;

export async function handler() {
  client ??= createServerlessMongoClientForBenchmark('read');

  return client.db('bench').collection<BenchmarkDocument>('documents')
    .findOne({ _id: 'seed' }, { readPreference: 'secondaryPreferred' });
}
