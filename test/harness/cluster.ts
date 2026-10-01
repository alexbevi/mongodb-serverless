import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const CONTAINER = 'mongodb-serverless-driver-test-rs';
const IMAGE = 'mongodb/mongodb-atlas-local:8.0';
const PORTS = [28017, 28018, 28019] as const;
const REPLICA_SET = 'rstest';

export interface TestCluster {
  /** Seed uri for the whole set, as a user would write it. */
  uri: string;
  /** `host:port` of the primary. */
  primary: string;
  /** `host:port` of each secondary. */
  secondaries: string[];
  /** The raw replSetGetStatus document, for plugins to serve. */
  status: Record<string, unknown>;
}

const docker = async (args: string[]): Promise<string> => {
  const { stdout } = await exec('docker', args, { maxBuffer: 1 << 24 });
  return stdout.trim();
};

const mongosh = async (port: number, script: string): Promise<string> =>
  docker(['exec', CONTAINER, 'mongosh', '--quiet', '--port', String(port), '--eval', script]);

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

const running = async (): Promise<boolean> => {
  const out = await docker(['ps', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}']);
  return out === CONTAINER;
};

/**
 * Starts a 3-node replica set in one container.
 *
 * `--hostname localhost` is what makes this usable: the driver connects to the
 * `host:port` names in replSetGetStatus, so those names have to resolve from
 * the host as well as inside the container. With the default hostname, member
 * names are the container id and nothing outside can reach them.
 *
 * Three mongod processes in one container rather than three containers, so
 * there is one thing to start, wait for, and remove.
 */
export async function startCluster(): Promise<void> {
  if (await running()) return;

  await docker(['rm', '-f', CONTAINER]).catch(() => '');

  const launch = PORTS.map(
    port =>
      `mkdir -p /tmp/rs${port} && mongod --replSet ${REPLICA_SET} --port ${port} ` +
      `--dbpath /tmp/rs${port} --bind_ip_all --fork --logpath /tmp/mongod-${port}.log`
  ).join(' && ');

  await docker([
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--hostname',
    'localhost',
    ...PORTS.flatMap(port => ['-p', `${port}:${port}`]),
    '--entrypoint',
    'bash',
    IMAGE,
    '-c',
    // dbpath under /tmp because the image runs as a non-root user that cannot
    // write to /data.
    `${launch} && tail -f /dev/null`
  ]);

  await waitFor(async () => {
    await mongosh(PORTS[0], 'db.version()');
    return true;
  }, 'mongod to accept connections');

  const members = PORTS.map(
    (port, index) => `{_id:${index}, host:"localhost:${port}", priority:${index === 0 ? 10 : 1}}`
  ).join(',');

  // Priority 10 on the first member makes the primary predictable, so a test
  // can assert which host served a write.
  await mongosh(PORTS[0], `rs.initiate({_id:"${REPLICA_SET}", members:[${members}]})`).catch(
    () => ''
  );

  await waitFor(async () => {
    const states = await mongosh(
      PORTS[0],
      'print(rs.status().members.map(m => m.stateStr).sort().join(","))'
    );
    return states === 'PRIMARY,SECONDARY,SECONDARY';
  }, 'the replica set to elect a primary and sync both secondaries');
}

export async function stopCluster(): Promise<void> {
  await docker(['rm', '-f', CONTAINER]).catch(() => '');
}

/** Reads the live topology, for a plugin to serve to the driver. */
export async function describeCluster(): Promise<TestCluster> {
  const raw = await mongosh(PORTS[0], 'print(JSON.stringify(rs.status()))');
  const status = JSON.parse(raw) as {
    members: Array<{ name: string; stateStr: string }>;
  };

  const primary = status.members.find(m => m.stateStr === 'PRIMARY')?.name;

  if (primary == null) throw new Error('Test cluster reports no primary');

  return {
    uri: `mongodb://${PORTS.map(p => `localhost:${p}`).join(',')}/?replicaSet=${REPLICA_SET}`,
    primary,
    secondaries: status.members.filter(m => m.stateStr === 'SECONDARY').map(m => m.name),
    status: status as unknown as Record<string, unknown>
  };
}

/** Steps down the primary, so a test can observe a failover. */
export async function stepDownPrimary(): Promise<void> {
  const { primary } = await describeCluster();
  const port = Number(primary.split(':')[1]);

  await mongosh(port, 'try { rs.stepDown(10) } catch (e) {}').catch(() => '');

  await waitFor(async () => {
    const current = await describeCluster();
    return current.primary !== primary;
  }, 'a new primary to be elected');
}

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 90_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}${detail}`);
}

const STANDALONE = 'mongodb-serverless-driver-test-standalone';

/** Port the standalone listens on, distinct from the replica set's. */
export const STANDALONE_PORT = 29200;

/**
 * Starts a single mongod with no replica set.
 *
 * Needed to prove the watcher rejects a server that has no topology. A direct
 * connection to one replica set member is not a substitute: it still reports
 * `setName`, so it passes the check it is meant to fail.
 */
export async function startStandalone(): Promise<void> {
  await docker(['rm', '-f', STANDALONE]).catch(() => '');

  await docker([
    'run',
    '-d',
    '--name',
    STANDALONE,
    '--hostname',
    'localhost',
    '-p',
    `${STANDALONE_PORT}:27017`,
    '--entrypoint',
    'bash',
    IMAGE,
    '-c',
    'mkdir -p /tmp/standalone && mongod --port 27017 --dbpath /tmp/standalone --bind_ip_all'
  ]);

  await waitFor(async () => {
    await docker(['exec', STANDALONE, 'mongosh', '--quiet', '--eval', 'db.version()']);
    return true;
  }, 'the standalone mongod to accept connections');
}

export async function stopStandalone(): Promise<void> {
  await docker(['rm', '-f', STANDALONE]).catch(() => '');
}
