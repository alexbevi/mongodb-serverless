import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSecureCluster } from '../test/harness/secure-cluster.js';

const exec = promisify(execFile);

const root = fileURLToPath(new URL('../', import.meta.url));

const fixture = await startSecureCluster();

for (const version of ['7.7.0', '^7.7.0']) {
  const directory = await mkdtemp(join(tmpdir(), 'no-monitoring-package-'));

  try {
    await exec('npm', ['run', 'build'], { cwd: root });
    const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', directory], { cwd: join(root, 'driver') });
    await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
    await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, stdout.trim()), `mongodb@${version}`], { cwd: directory });
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

    const architecture = await readFile(join(root, 'docs/architecture.md'), 'utf8');
    const bootstrap = architecture.match(/```js\n([\s\S]*?)```/)?.[1];

    if (!bootstrap) throw new Error('No bootstrap example');
    await writeFile(join(directory, 'bootstrap.mjs'), prefix + bootstrap);

    const bootstrapCjs = bootstrap.replace(
      "import { MongoClient } from '@mongodb-serverless/driver';",
      "const { MongoClient } = require('@mongodb-serverless/driver');"
    );

    await writeFile(join(directory, 'bootstrap.cjs'), `(async () => {\n${prefix}${bootstrapCjs}\n})().catch(error => { console.error(error); process.exitCode = 1; });\n`);

    const rootReadme = await readFile(join(root, 'README.md'), 'utf8');
    const quickstart = rootReadme.split('## Quickstart')[1]?.match(/```ts\n([\s\S]*?)```/)?.[1];

    if (!quickstart) throw new Error('No root quickstart example');
    await writeFile(join(directory, 'quickstart.mjs'), prefix + quickstart + '\nawait client.close();\n');

    const srvPrefix = `
      import dns from 'node:dns';
      dns.promises.resolve = async (_host, kind) => kind === 'SRV'
        ? [{ name: 'member.cluster.localhost', port: 29400, weight: 0, priority: 0 }]
        : [['authSource=admin&replicaSet=securetest']];
      const uri = 'mongodb+srv://test:fixture-password@cluster.localhost/app?tlsCAFile=' + ${JSON.stringify(encodeURIComponent(fixture.ca))};
    `;

    const srvExample = bootstrap.replace('disableMonitoring: true,', `
      lookup: (_hostname, options, callback) => dns.lookup('localhost', options, callback),
      servername: 'localhost', disableMonitoring: true,`);

    await writeFile(join(directory, 'bootstrap-srv.mjs'), srvPrefix + srvExample);

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

    for (const file of ['example.mjs', 'example.cjs', 'bootstrap.mjs', 'bootstrap.cjs', 'bootstrap-srv.mjs', 'quickstart.mjs', 'isolation.mjs']) {
      await exec(process.execPath, [file], { cwd: directory });
      await exec('npx', ['--yes', '--package=node@20.19.0', 'node', file], { cwd: directory });
    }

    const installed = await exec(process.execPath, ['-p', "require('mongodb/package.json').version"], { cwd: directory });
    console.log(`mongodb ${installed.stdout.trim()}: packed examples and module isolation passed on ${process.version} and Node 20.19.0`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
