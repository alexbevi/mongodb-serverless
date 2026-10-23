import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const run = promisify(execFile);

const exampleDirectory = dirname(fileURLToPath(import.meta.url));

const repositoryDirectory = resolve(exampleDirectory, '../..');

export const bundles = [
  { name: 'native-find', entry: 'src/native/find.ts' },
  { name: 'native-save', entry: 'src/native/save.ts' },
  { name: 'no-plugin-find', entry: 'src/no-plugin/find.ts' },
  { name: 'no-plugin-save', entry: 'src/no-plugin/save.ts' },
  { name: 'aws-ssm-find', entry: 'src/aws-ssm/find.ts' },
  { name: 'aws-ssm-save', entry: 'src/aws-ssm/save.ts' }
] as const;

interface BuiltBundle {
  name: string;
  bundleBytes: number;
  zipBytes: number;
}

export interface BuildManifest {
  bundles: BuiltBundle[];
}

export async function buildExamples(outputDirectory = join(exampleDirectory, 'dist')): Promise<BuildManifest> {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const built: BuiltBundle[] = [];

  for (const bundle of bundles) {
    const bundleDirectory = join(outputDirectory, bundle.name);
    const output = join(bundleDirectory, 'index.mjs');
    const archive = join(outputDirectory, `${bundle.name}.zip`);

    await mkdir(bundleDirectory, { recursive: true });
    await build({
      entryPoints: [join(exampleDirectory, bundle.entry)],
      outfile: output,
      bundle: true,
      treeShaking: true,
      minify: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'silent',
      alias: {
        '@mongodb-serverless/driver': join(repositoryDirectory, 'driver/src/index.ts'),
        '@mongodb-serverless/plugin-aws-ssm': join(repositoryDirectory, 'plugins/aws-ssm/src/index.ts')
      },
      external: [
        '@aws-sdk/*', '@mongodb-js/zstd', 'aws4', 'gcp-metadata', 'kerberos',
        'mongodb-client-encryption', 'snappy', 'socks'
      ],
      banner: {
        js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);"
      }
    });

    await run('zip', ['-q', '-j', archive, output]);

    built.push({
      name: bundle.name,
      bundleBytes: (await stat(output)).size,
      zipBytes: (await stat(archive)).size
    });
  }

  const manifest: BuildManifest = { bundles: built };
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildExamples();

  for (const bundle of manifest.bundles) {
    process.stdout.write(`${bundle.name}: ${bundle.zipBytes.toLocaleString()} bytes zipped\n`);
  }
}
