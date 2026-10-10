import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);

const container = 'mongodb-serverless-driver-test-secure';

const uri = 'mongodb://test:fixture-password@localhost:29400/admin?replicaSet=securetest';

let fixture: Promise<{ uri: string; ca: string }> | undefined;

export function startSecureCluster(): Promise<{ uri: string; ca: string }> {
  fixture ??= start();

  return fixture;
}

async function start(): Promise<{ uri: string; ca: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'mongodb-secure-'));
  const ca = join(directory, 'ca.pem');
  const { stdout } = await exec('docker', ['ps', '--filter', `name=^${container}$`, '--format', '{{.Names}}']);

  if (stdout.trim() === container) {
    await exec('docker', ['cp', `${container}:/certs/ca.pem`, ca]);

    return { uri, ca };
  }

  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', ca]);
  await writeFile(join(directory, 'server.pem'), (await readFile(join(directory, 'key.pem'))) + '\n' + (await readFile(ca)));
  await writeFile(join(directory, 'keyfile'), randomBytes(48).toString('base64'), { mode: 0o600 });
  await exec('docker', ['run', '-d', '--name', container, '--hostname', 'localhost', '--user', 'root',
    '-p', '29400:29400', '--entrypoint', 'bash', 'mongodb/mongodb-atlas-local:8.0', '-c',
    'mkdir -p /certs /tmp/secure && while [ ! -f /certs/ready ]; do sleep 0.1; done; ' +
    'chmod 600 /certs/keyfile; exec mongod --port 29400 --bind_ip_all --dbpath /tmp/secure ' +
    '--replSet securetest --keyFile /certs/keyfile --tlsMode preferTLS ' +
    '--tlsCertificateKeyFile /certs/server.pem --tlsCAFile /certs/ca.pem --tlsAllowConnectionsWithoutCertificates']);

  for (const file of ['server.pem', 'ca.pem', 'keyfile']) {
    await exec('docker', ['cp', join(directory, file), `${container}:/certs/${file}`]);
  }

  await exec('docker', ['exec', container, 'touch', '/certs/ready']);

  const shell = async (script: string): Promise<void> => {
    await exec('docker', ['exec', container, 'mongosh', '--quiet', '--port', '29400', '--eval', script]);
  };

  await waitFor(async () => shell('db.version()'));
  await shell('rs.initiate({_id:"securetest",members:[{_id:0,host:"localhost:29400"}]})');
  await waitFor(async () => shell('if (!db.hello().isWritablePrimary) throw Error("not primary")'));
  await shell('db.getSiblingDB("admin").createUser({user:"test",pwd:"fixture-password",roles:["root"]})');
  await rm(join(directory, 'key.pem'));
  await rm(join(directory, 'keyfile'));
  await rm(join(directory, 'server.pem'));

  return { uri, ca };
}

async function waitFor(action: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await action();

      return;
    } catch (cause) {
      if (attempt >= 60) throw cause;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
