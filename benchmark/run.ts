import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../..', import.meta.url));
process.chdir(root);
const { values } = parseArgs({ options: { samples: { type: 'string', default: '48' }, output: { type: 'string', default: 'benchmark/results/latest.json' }, 'local-rtt': { type: 'string', default: '0.5' }, 'cross-rtt': { type: 'string', default: '2' } } });
const count = Number(values.samples);
const localRtt = Number(values['local-rtt']);
const crossRtt = Number(values['cross-rtt']);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('--samples must be an integer from 1 to 10000');
if (![localRtt, crossRtt].every(n => Number.isFinite(n) && n > 0 && n <= 1000)) throw new Error('RTTs must be in (0, 1000] milliseconds');
const compose = (...args: string[]) => execFileSync('docker', ['compose', '-f', 'benchmark/docker/compose.yaml', ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 600_000, maxBuffer: 20 * 1024 * 1024 });
const inside = (service: string, ...args: string[]) => compose('exec', '-T', service, ...args);
const shell = (script: string, authenticated = false) => inside('mongo-a', 'mongosh', '--quiet', '--tls', '--tlsCAFile', '/certs/ca.crt', ...(authenticated ? ['-u', 'bench', '-p', 'benchmark-only', '--authenticationDatabase', 'admin'] : []), '--eval', script);
async function waitFor(action: () => unknown) {
  let cause;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { return action(); } catch (error) { cause = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Cluster did not become ready', { cause });
}
const nodes = [ { name: 'client', ip: '172.30.91.10', az: 'a' }, { name: 'mongo-a', ip: '172.30.91.11', az: 'a' }, { name: 'mongo-b', ip: '172.30.91.12', az: 'b' }, { name: 'mongo-c', ip: '172.30.91.13', az: 'c' } ];
try {
  compose('build');
  compose('run', '--rm', '--no-deps', 'certificates');
  compose('up', '-d', 'mongo-a', 'mongo-b', 'mongo-c', 'client');
  await waitFor(() => shell('if (db.adminCommand({ping:1}).ok !== 1) throw Error("ping failed")'));
  shell('if (rs.initiate({_id:"benchmark",members:[{_id:0,host:"mongo-a:27017",priority:10},{_id:1,host:"mongo-b:27017",priority:0},{_id:2,host:"mongo-c:27017",priority:0}]}).ok !== 1) throw Error("initiate failed")');
  await waitFor(() => shell('if (!db.hello().isWritablePrimary) throw Error("waiting for primary")'));
  shell('db.getSiblingDB("admin").createUser({user:"bench",pwd:"benchmark-only",roles:["root"]})');
  await waitFor(() => inside('client', 'node', 'benchmark/dist/setup.js'));
  const network: { source: string; target: string; configuredRttMs: number; measuredRttMs?: number }[] = [];
  for (const source of nodes) {
    inside(source.name, 'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'handle', '1:', 'prio', 'bands', '4', 'priomap', ...Array(16).fill('3'));
    let band = 1;
    for (const target of nodes.filter(n => n !== source)) {
      const rtt = source.az === target.az ? localRtt : crossRtt;
      inside(source.name, 'tc', 'qdisc', 'replace', 'dev', 'eth0', 'parent', `1:${band}`, 'handle', `${band + 10}:`, 'netem', 'delay', `${rtt / 2}ms`);
      inside(source.name, 'tc', 'filter', 'add', 'dev', 'eth0', 'protocol', 'ip', 'parent', '1:', 'prio', '1', 'u32', 'match', 'ip', 'dst', `${target.ip}/32`, 'flowid', `1:${band}`);
      network.push({ source: source.name, target: target.name, configuredRttMs: rtt });
      band++;
    }
  }
  for (const link of network) {
    const ping = inside(link.source, 'ping', '-n', '-c', '5', '-i', '0.05', nodes.find(n => n.name === link.target)!.ip);
    const match = ping.match(/= [\d.]+\/([\d.]+)\//);
    if (!match) throw new Error(`Cannot parse RTT: ${ping}`);
    link.measuredRttMs = Number(match[1]);
    if (link.measuredRttMs < link.configuredRttMs * 0.8) throw new Error(`Network delay not applied: ${JSON.stringify(link)}`);
  }
  const samples = [];
  for (let iteration = 0; iteration < count; iteration++) {
    const variants = (iteration + Math.floor(iteration / 6)) % 2 ? ['serverless', 'native'] : ['native', 'serverless'];
    for (const operation of ['read', 'write']) {
      for (const variant of variants) samples.push({ iteration, ...JSON.parse(inside('client', 'node', 'benchmark/dist/sample.js', variant, operation, String(iteration))) });
    }
  }
  const output = resolve(values.output!);
  mkdirSync(dirname(output), { recursive: true });
  const environment = { docker: execFileSync('docker', ['version', '--format', '{{json .Server}}'], { encoding: 'utf8' }).trim(), client: inside('client', 'uname', '-a').trim(), mongo: inside('mongo-a', 'mongod', '--version').trim(), images: compose('images', '--format', 'json').trim(), gitDirty: execFileSync('git', ['status', '--porcelain', '--', 'benchmark', 'driver', 'plugins'], { encoding: 'utf8' }).trim().length > 0, git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  writeFileSync(output, JSON.stringify({ createdAt: new Date().toISOString(), configuration: { seedOrder: 'cycle-six-permutations', count, localRtt, crossRtt, tls: true, auth: 'SCRAM-SHA-256', readPreference: 'primary', writeConcern: 'majority' }, environment, network, samples }, null, 2) + '\n');
  console.log(`Saved ${samples.length} cold samples to ${output}`);
} finally {
  try {
    compose('down', '--volumes', '--remove-orphans', '--rmi', 'local');
  } finally {
    execFileSync('docker', ['image', 'prune', '--force', '--filter', 'label=com.docker.compose.project=mongodb-latency-benchmark'], { stdio: 'pipe', timeout: 60_000 });
  }
}
