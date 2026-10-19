import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const output = resolve(process.argv[2] ?? 'benchmark/dist/lambda-package');

rmSync(output, { recursive: true, force: true });

mkdirSync(output, { recursive: true });

for (const path of ['driver', 'plugins/aws-ssm']) {
  cpSync(join(root, path, 'dist'), join(output, path, 'dist'), { recursive: true });
  cpSync(join(root, path, 'package.json'), join(output, path, 'package.json'));
}

const modules = ['lambda-worker', 'lambda-lifecycle', 'patterns', 'instrument', 'activities', 'execution', 'cpu', 'types', 'aws-diagnostics', 'source-probes'];

mkdirSync(join(output, 'benchmark/dist'), { recursive: true });

for (const module of modules) cpSync(join(root, 'benchmark/dist', `${module}.js`), join(output, 'benchmark/dist', `${module}.js`));

writeFileSync(join(output, 'package.json'), JSON.stringify({
  name: 'mongodb-pattern-benchmark', private: true, type: 'module',
  dependencies: { mongodb: '7.7.0', 'mongodb-connection-string-url': '7.0.2', '@aws-sdk/client-ssm': '3.1146.0' }
}, null, 2));

execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: output, stdio: 'inherit' });

execFileSync(process.execPath, ['benchmark/dist/source-probes.js'], { cwd: output });

rmSync(resolve(output, '../lambda-worker.zip'), { force: true });

execFileSync('zip', ['-q', '-r', '../lambda-worker.zip', 'benchmark', 'driver', 'plugins', 'node_modules', 'package.json'], { cwd: output });

console.log('Built current Lambda worker');
