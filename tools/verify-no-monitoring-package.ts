import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSecureCluster } from '../test/harness/secure-cluster.js';

const exec = promisify(execFile);

const root = fileURLToPath(new URL('../', import.meta.url));

const directory = await mkdtemp(join(tmpdir(), 'no-monitoring-package-'));

const fixture = await startSecureCluster();

try {
  await exec('npm', ['run', 'build'], { cwd: root });
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', directory], { cwd: join(root, 'driver') });
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, stdout.trim()), 'mongodb@7.7.0'], { cwd: directory });
  const readme = await readFile(join(root, 'driver/README.md'), 'utf8');
  const section = readme.split('### Disable monitoring')[1];
  const example = section?.match(/```js\n([\s\S]*?)```/)?.[1];

  if (!example) throw new Error('No native no-monitoring README example');
  const uri = fixture.uri + '&tls=true&tlsCAFile=' + encodeURIComponent(fixture.ca);
  const prefix = `const uri = ${JSON.stringify(uri)};\n`;
  await writeFile(join(directory, 'example.mjs'), prefix + example);

  const commonjs = example
    .replace("import { MongoClient } from 'mongodb';", "const { MongoClient } = require('mongodb');")
    .replace("import { disableMonitoring } from '@mongodb-serverless/driver/no-monitoring';", "const { disableMonitoring } = require('@mongodb-serverless/driver/no-monitoring');");

  await writeFile(join(directory, 'example.cjs'), `(async () => {\n${prefix}${commonjs}\n})().catch(error => { console.error(error); process.exitCode = 1; });\n`);

  await cp(join(directory, 'node_modules/mongodb'), join(directory, 'node_modules/mongodb-other'), { recursive: true });
  await cp(join(directory, 'node_modules/@mongodb-serverless/driver'), join(directory, 'node_modules/@mongodb-serverless/driver-copy'), { recursive: true });

  const isolation = `
    import assert from 'node:assert/strict';
    import { MongoClient } from 'mongodb';
    import { MongoClient as ForeignClient } from './node_modules/mongodb-other/lib/index.js';
    import { disableMonitoring } from '@mongodb-serverless/driver/no-monitoring';
    import { disableMonitoring as secondCopy } from './node_modules/@mongodb-serverless/driver-copy/dist/driver/src/no-monitoring/index.js';
    import { Monitor } from 'mongodb/lib/sdam/monitor.js';
    assert.throws(() => disableMonitoring(new ForeignClient(uri, { directConnection: true })), /same mongodb module/);
    const first = disableMonitoring(new MongoClient(uri, { directConnection: true }));
    const installed = Monitor.prototype.connect;
    const second = secondCopy(new MongoClient(uri, { directConnection: true }));
    assert.equal(Monitor.prototype.connect, installed);
    try {
      await Promise.all([first.connect(), second.connect()]);
      await Promise.all([first.db('admin').command({ listDatabases: 1 }), second.db('admin').command({ listDatabases: 1 })]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  `;

  await writeFile(join(directory, 'isolation.mjs'), prefix + isolation);

  for (const file of ['example.mjs', 'example.cjs', 'isolation.mjs']) {
    await exec(process.execPath, [file], { cwd: directory });
    await exec('npx', ['--yes', '--package=node@20.19.0', 'node', file], { cwd: directory });
  }

  console.log(`Packed examples and module isolation passed as ESM and CommonJS on ${process.version} and Node 20.19.0`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
