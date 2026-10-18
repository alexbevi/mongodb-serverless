import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const output = resolve(process.argv[2] ?? 'benchmark/dist/lambda-package');

const baseline = process.argv[3] ?? 'origin/main';

const revision = execFileSync('git', ['rev-parse', baseline], { cwd: root, encoding: 'utf8' }).trim();

const extracted = mkdtempSync(join(tmpdir(), 'mongodb-main-baseline-'));

execFileSync('tar', ['-xf', '-', '-C', extracted], {
  input: execFileSync('git', ['archive', revision, 'driver', 'plugins/shared', 'tsconfig.base.json', 'package.json'], { cwd: root })
});

symlinkSync(join(root, 'node_modules'), join(extracted, 'node_modules'), 'dir');

execFileSync('pnpm', ['exec', 'tsc', '--build', join(extracted, 'driver')], { cwd: root, stdio: 'inherit' });

mkdirSync(output, { recursive: true });

for (const path of ['driver', 'plugins/ssm']) {
  cpSync(join(root, path, 'dist'), join(output, path, 'dist'), { recursive: true });
  cpSync(join(root, path, 'package.json'), join(output, path, 'package.json'));
}

cpSync(join(extracted, 'driver/dist'), join(output, 'baseline/driver/dist'), { recursive: true });

cpSync(join(extracted, 'driver/package.json'), join(output, 'baseline/driver/package.json'));

const modules = ['lambda-worker', 'patterns', 'instrument', 'activities', 'execution', 'cpu', 'types'];

mkdirSync(join(output, 'benchmark/dist'), { recursive: true });

for (const module of modules) cpSync(join(root, 'benchmark/dist', `${module}.js`), join(output, 'benchmark/dist', `${module}.js`));

writeFileSync(join(output, 'package.json'), JSON.stringify({
  name: 'mongodb-pattern-benchmark', private: true, type: 'module',
  dependencies: { mongodb: '7.7.0', 'mongodb-connection-string-url': '7.0.2', '@aws-sdk/client-ssm': '3.1146.0' }
}, null, 2));

writeFileSync(join(output, 'baseline.json'), JSON.stringify({ revision }));

execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: output, stdio: 'inherit' });

execFileSync('zip', ['-q', '-r', '../lambda-worker.zip', 'benchmark', 'driver', 'baseline', 'plugins', 'node_modules', 'package.json', 'baseline.json'], { cwd: output });

console.log(`Built Lambda worker with main baseline ${revision}`);
