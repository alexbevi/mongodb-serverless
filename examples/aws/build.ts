import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const run = promisify(execFile);

const rootRequire = createRequire(import.meta.url);

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

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
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
    const usesServerlessDriver = bundle.name.startsWith('no-plugin-') || bundle.name.startsWith('aws-ssm-');

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
        'mongodb-client-encryption', 'snappy', 'socks',
        ...(usesServerlessDriver ? ['mongodb'] : [])
      ],
      banner: {
        js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);"
      }
    });

    if (usesServerlessDriver) {
      await copyPackage('mongodb', join(bundleDirectory, 'node_modules'), rootRequire, new Set());
    }

    await run('zip', ['-q', '-r', archive, '.'], { cwd: bundleDirectory });

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

async function copyPackage(
  name: string,
  nodeModulesDirectory: string,
  resolver: NodeJS.Require,
  copied: Set<string>
): Promise<void> {
  if (copied.has(name)) return;

  const source = await packageDirectory(name, resolver);
  const manifest: PackageManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const destination = join(nodeModulesDirectory, ...name.split('/'));

  copied.add(name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });

  const childResolver = createRequire(join(source, 'package.json'));

  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyPackage(dependency, nodeModulesDirectory, childResolver, copied);
  }
}

async function packageDirectory(name: string, resolver: NodeJS.Require): Promise<string> {
  try {
    return dirname(resolver.resolve(`${name}/package.json`));
  } catch {
    // Packages may hide their manifest with an exports map.
  }

  let directory = dirname(resolver.resolve(name));

  while (directory !== dirname(directory)) {
    try {
      const manifest: PackageManifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));

      if (manifest.name === name) return directory;
    } catch {
      // Keep walking from the package entry point to its manifest.
    }

    directory = dirname(directory);
  }

  throw new Error(`Cannot locate package ${name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildExamples();

  for (const bundle of manifest.bundles) {
    process.stdout.write(`${bundle.name}: ${bundle.zipBytes.toLocaleString()} bytes zipped\n`);
  }
}
