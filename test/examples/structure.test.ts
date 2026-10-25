import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parseManifest } from '../../driver/test/harness/package-manifest.js';

const examples = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples');

it('keeps one minimal AWS example', async () => {
  const entries = await readdir(examples, { withFileTypes: true });

  expect(entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
    .toEqual(['aws-lambda']);
  expect(entries.filter(entry => entry.isFile()).map(entry => entry.name)).toEqual([]);

  for (const name of ['aws-lambda']) {
    const files = await readdir(resolve(examples, name), { withFileTypes: true });

    expect(files.filter(entry => entry.isFile()).map(entry => entry.name).sort())
      .toEqual(['index.ts', 'package.json']);
    expect(files.filter(entry => entry.isDirectory() && entry.name !== 'node_modules')).toEqual([]);
  }
});

it('references published packages rather than workspace-only dependency ranges', async () => {
  for (const name of ['aws-lambda']) {
    const manifest = parseManifest(await readFile(resolve(examples, name, 'package.json'), 'utf8'));

    const dependencies = manifest.dependencies ?? {};

    expect(dependencies['@mongodb-serverless/driver']).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(Object.values(dependencies).every(version => !/^(?:file|link|workspace):/.test(version))).toBe(true);
  }
});
