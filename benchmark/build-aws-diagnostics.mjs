import { cpSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchmark = dirname(fileURLToPath(import.meta.url));

export function instrumentWorker(source, directory = benchmark) {
  const replacements = [
    ['import { instrument } from "./instrument.mjs";',
      `import { instrument } from ${JSON.stringify(join(directory, 'instrument.ts'))};\nimport { activities } from ${JSON.stringify(join(directory, 'activities.ts'))};\nimport { measureAwsOperation } from ${JSON.stringify(join(directory, 'aws-diagnostics.ts'))};`],
    ['() => createBenchmarkClient(event.mode, uri, options, on)',
      '() => activities.sync("Facade / client construction", () => createBenchmarkClient(event.mode, uri, options, on))'],
    ['  const start = performance.now();\n  try {\n    const result = await handler();\n    const end = performance.now();',
      '  try {\n    const { result, start, end, execution, activities: spans } = await measureAwsOperation(handler);'],
    ['trace: { start, end, dns:', 'trace: { start, end, execution, activities: spans, dns:'],
  ];

  for (const [target, replacement] of replacements) {
    if (source.split(target).length !== 2) throw new Error(`Re-verify AWS worker: ${target}`);
    source = source.replace(target, replacement);
  }

  return source;
}

async function buildWorker(application, output) {
  const require = createRequire(join(application, 'package.json'));
  const { build } = require('esbuild');
  mkdirSync(output, { recursive: true });
  cpSync(join(application, 'vendor'), join(output, '../vendor'), { recursive: true });

  for (const file of ['package.json', 'package-lock.json']) {
    cpSync(join(application, 'worker-runtime', file), join(output, file));
  }

  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: output, stdio: 'inherit' });
  symlinkSync(join(output, 'node_modules/@mongodb-serverless/driver'), join(output, 'driver'), 'dir');
  execFileSync(process.execPath, [join(benchmark, 'source-probes.ts')], { cwd: output, stdio: 'inherit' });
  await build({
    entryPoints: [join(application, 'api/benchmark/worker.ts')],
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile: join(output, 'index.mjs'),
    minify: false,
    plugins: [{
      name: 'benchmark-diagnostics',
      setup(build) {
        build.onLoad({ filter: /api\/benchmark\/worker\.ts$/ }, args => ({
          contents: instrumentWorker(readFileSync(args.path, 'utf8')),
          loader: 'ts',
          resolveDir: dirname(args.path),
        }));
      },
    }],
  });
  execFileSync('zip', ['-q', '-r', '../worker.zip', 'index.mjs', 'package.json', 'node_modules'], { cwd: output });
  console.log(join(output, '../worker.zip'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [application, output] = process.argv.slice(2);

  if (!application || !output) throw new Error('Usage: node benchmark/build-aws-diagnostics.mjs APPLICATION_DIRECTORY NEW_OUTPUT_DIRECTORY');
  await buildWorker(resolve(application), resolve(output));
}
