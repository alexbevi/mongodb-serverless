import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { buildExamples, bundles } from '../build.js';

const run = promisify(execFile);

it('defines one small bundle for every public example endpoint', () => {
  expect(bundles.map(bundle => bundle.name)).toEqual([
    'native-find', 'native-save',
    'no-plugin-find', 'no-plugin-save',
    'aws-ssm-find', 'aws-ssm-save'
  ]);
});

it('tree-shakes each handler into a deployable zip', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'mongodb-serverless-aws-'));

  try {
    const manifest = await buildExamples(outputDirectory);

    expect(manifest.bundles).toHaveLength(6);

    for (const bundle of manifest.bundles) {
      const archive = await stat(join(outputDirectory, `${bundle.name}.zip`));
      const source = await readFile(join(outputDirectory, bundle.name, 'index.mjs'), 'utf8');

      expect(archive.size).toBe(bundle.zipBytes);
      expect(bundle.bundleBytes).toBeGreaterThan(0);
      expect(bundle.zipBytes).toBeLessThan(2_000_000);
      expect(source).not.toContain('sourceMappingURL');

      const files = (await run('unzip', ['-Z1', join(outputDirectory, `${bundle.name}.zip`)])).stdout;

      if (bundle.name.startsWith('no-plugin-') || bundle.name.startsWith('aws-ssm-')) {
        expect(files).toContain('node_modules/mongodb/package.json');
      }
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
