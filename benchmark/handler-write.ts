import type { MongoClient } from 'mongodb';
import type { MongoClient as ServerlessMongoClient } from '../driver/dist/driver/src/index.js';
import { createServerlessMongoClientForBenchmark, type BenchmarkDocument } from './handler-base.js';

let client: MongoClient | ServerlessMongoClient | undefined;

export async function handler() {
  client ??= createServerlessMongoClientForBenchmark('write');

  return client.db('bench').collection<BenchmarkDocument>('documents')
    .updateOne({ _id: 'seed' }, { $inc: { value: 1 } });
}
