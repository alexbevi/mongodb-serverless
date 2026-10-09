import type { Collection, Db } from 'mongodb';
import { createBulkProxy } from '../../src/bulk.js';
import { createCursorProxy } from '../../src/cursor.js';

declare const collection: Collection;

declare const db: Db;

createCursorProxy(async () => collection.find(), 'find');

createCursorProxy(async () => collection.find<{ a: number }>({}).map(doc => doc.a), 'mapped find');

createCursorProxy(async () => collection.aggregate(), 'aggregate');

createCursorProxy(async () => collection.listIndexes(), 'listIndexes');

createCursorProxy(async () => collection.listSearchIndexes(), 'listSearchIndexes');

createCursorProxy(async () => db.listCollections(), 'listCollections');

createCursorProxy(async () => db.runCursorCommand({}), 'runCursorCommand');

// @ts-expect-error Deferred cursor sources must support cursor operations and async iteration.
createCursorProxy(async () => ({}), 'invalid');

createBulkProxy(async () => collection.initializeOrderedBulkOp(), 'ordered');

createBulkProxy(async () => collection.initializeUnorderedBulkOp(), 'unordered');

// @ts-expect-error Deferred bulk sources must provide the driver's builder operations.
createBulkProxy(async () => ({}), 'invalid');
