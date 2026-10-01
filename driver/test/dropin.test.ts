import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const built = join(pkgRoot, 'dist/index.js');

/**
 * Runs a script against the built package, outside vitest's resolver.
 *
 * Vitest aliases workspace packages to source, which hides exactly the kind of
 * module resolution problem this is checking for.
 */
const run = (filename: string, source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'serverless-dropin-'));
  const file = join(dir, filename);
  writeFileSync(file, source);

  return execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim();
};

describe.skipIf(!existsSync(built))('drop-in resolution', () => {
  it('serves ESM named imports', () => {
    const output = run(
      'app.mjs',
      `import { MongoClient, ObjectId, ReadPreference } from '${built}';
       console.log([
         MongoClient.name,
         typeof ObjectId,
         ReadPreference.PRIMARY
       ].join('|'));`
    );

    expect(output).toBe('ServerlessMongoClient|function|primary');
  });

  it('serves CJS require', () => {
    const output = run(
      'app.cjs',
      `const { MongoClient, ObjectId } = require('${built}');
       console.log([MongoClient.name, typeof ObjectId].join('|'));`
    );

    expect(output).toBe('ServerlessMongoClient|function');
  });

  it('gives the same ObjectId as the real driver', () => {
    const output = run(
      'same.mjs',
      `import { ObjectId } from '${built}';
       const mongodb = await import('${join(pkgRoot, 'node_modules/mongodb/lib/index.js')}');
       console.log(ObjectId === mongodb.ObjectId);`
    );

    expect(output).toBe('true');
  });

  it('does not give the real MongoClient', () => {
    const output = run(
      'differs.mjs',
      `import { MongoClient } from '${built}';
       const mongodb = await import('${join(pkgRoot, 'node_modules/mongodb/lib/index.js')}');
       console.log(MongoClient !== mongodb.MongoClient);`
    );

    expect(output).toBe('true');
  });

  it('constructs a client without a connection', () => {
    const output = run(
      'construct.mjs',
      `import { MongoClient, MissingPluginError } from '${built}';
       const client = new MongoClient('mongodb://host:27017/db');
       try {
         await client.db('app').collection('c').findOne({});
         console.log('unexpected');
       } catch (error) {
         console.log(error instanceof MissingPluginError);
       }`
    );

    expect(output).toBe('true');
  });
});
