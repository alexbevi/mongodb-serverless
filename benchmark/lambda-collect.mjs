import assert from 'node:assert/strict';
import { DeleteParametersCommand } from '@aws-sdk/client-ssm';
import { UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand, PublishVersionCommand, InvokeCommand, DeleteFunctionCommand, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const variants = ['native', 'no-plugin', 'ssm', 'ssm-uncached'];

export const workerPatterns = prefix => variants.flatMap(variant => ['read', 'write'].map(operation => ({ name: `${prefix}-${variant}-${operation}`, variant, operation })));

export const workerNames = prefix => workerPatterns(prefix).map(pattern => pattern.name);

export const topologyParameterFor = (prefix, variant, operation) =>
  `/${prefix}/topology${variant === 'ssm-uncached' ? `-miss-${operation}` : ''}`;

async function clearUncachedTopology(ssm, prefix) {
  const Names = ['read', 'write'].map(operation => topologyParameterFor(prefix, 'ssm-uncached', operation));
  await ssm.send(new DeleteParametersCommand({ Names }));
}

async function invoke(lambda, name, version, event) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: name, Qualifier: version, LogType: 'Tail', Payload: Buffer.from(JSON.stringify(event)) }));
  const result = JSON.parse(Buffer.from(response.Payload).toString('utf8'));

  if (response.FunctionError) throw new Error(`Worker failed: ${result.errorType}: ${result.errorMessage}`);
  assert.ok(result.verified);
  const log = Buffer.from(response.LogResult ?? '', 'base64').toString('utf8');
  const init = /Init Duration: ([\d.]+) ms/.exec(log);
  const duration = /REPORT[^\n]*?\bDuration: ([\d.]+) ms/.exec(log);

  return { ...result, lambda: { version, initMs: init ? Number(init[1]) : result.initialization?.processReadyMs ?? null, initSource: init ? 'lambda-report' : result.initialization ? 'node-process-clock' : null, durationMs: duration ? Number(duration[1]) : null } };
}

export async function invokeCold(lambda, name, version, event) {
  const result = await invoke(lambda, name, version, event);
  assert.ok(result.cold, 'A warm invocation cannot enter the cold cohort');

  return result;
}

export function assertWarmReuse(cold, warm) {
  assert.ok(cold.cold && !warm.cold && warm.verified);
  assert.equal(warm.environmentId, cold.environmentId, 'The warm call must reuse its execution environment');
  assert.equal(cold.clientConstructions, 1);
  assert.equal(warm.clientConstructions, 1, 'The warm call must retain the client');
  assert.equal(warm.monitorSockets, 0);

  if (warm.variant === 'native' && warm.operation === 'read') {
    assert.ok(warm.sockets <= 1, 'A nearest read may open a pool connection to another member');
    assert.equal(warm.sockets, warm.authenticatedSockets);
  } else {
    assert.equal(warm.sockets, 0);
    assert.equal(warm.trace.command.socket.start, cold.trace.command.socket.start, 'The warm call must reuse its MongoDB socket');
  }

  assert.ok(warm.trace.command.start >= warm.trace.start, 'The command must belong to this invocation');

  for (const field of ['ssmReads', 'ssmWrites', 'discoveryCommands']) assert.equal(warm[field], 0, field);
  assert.deepEqual(warm.dns, []);
}

export async function verifyWarmInvocations(lambda, prefix, ssm) {
  await clearUncachedTopology(ssm, prefix);
  const checks = [];

  for (const { name, variant, operation } of workerPatterns(prefix)) {
    const cold = await invokeCold(lambda, name, '$LATEST', { variant, operation });
    const warm = await invoke(lambda, name, '$LATEST', { variant, operation });
    assertWarmReuse(cold, warm);
    checks.push({ variant, operation, verified: true, totalMs: warm.totalMs, servedRole: warm.servedRole,
      sockets: warm.sockets, ssmReads: warm.ssmReads, ssmWrites: warm.ssmWrites,
      discoveryCommands: warm.discoveryCommands, dns: warm.dns, sameEnvironment: true, sameClient: true, sameSocket: warm.trace.command.socket.start === cold.trace.command.socket.start });
  }

  return checks;
}

export async function collect(lambda, ssm, prefix, count, file, metadata) {
  const start = Date.now();
  const names = workerNames(prefix);

  const settings = await Promise.all(names.map(async name => {
    const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));

    return { name, environment: config.Environment.Variables };
  }));

  const samples = [];
  const seen = new Set();
  const data = { createdAt: new Date(start).toISOString(), configuration: { count, variants, batches: 4, readPreference: 'nearest', writes: 'primary / majority', timing: 'SSM fetched during INIT; handler through result; client retained for warm invocations', ...metadata }, samples, executionSources: [], failures: [] };
  mkdirSync(dirname(file), { recursive: true });
  const members = new Map();
  const sourceIds = new Map();

  const member = address => {
    const host = address.replace(/:\d+$/, '');

    if (!members.has(host)) members.set(host, `member-${members.size + 1}`);

    return `${members.get(host)}${address.slice(host.length)}`;
  };

  const publicData = (key, value) => {
    if (key === 'host' || key === 'address') return member(value);

    if (key === 'hosts' || key === 'servers') return value.map(member);

    if (key === 'replicaSet' && value) return 'replica-set';

    return value;
  };

  const save = () => writeFileSync(file, JSON.stringify({ ...data, elapsedMs: Date.now() - start }, publicData, 2) + '\n');

  try {
    for (let iteration = 0; iteration < count; iteration += 1) {
      await clearUncachedTopology(ssm, prefix);
      const versions = new Map(await Promise.all(settings.map(async setting => {
        await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: setting.name, Environment: { Variables: { ...setting.environment, COLD_NONCE: randomUUID() } } }));
        await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120, minDelay: 1, maxDelay: 2 }, { FunctionName: setting.name });
        const published = await lambda.send(new PublishVersionCommand({ FunctionName: setting.name }));
        assert.ok(published.Version && published.Version !== '$LATEST');

        return [setting.name, published.Version];
      })));

      const order = variants.map((_, index) => variants[(index + iteration) % variants.length]);

      if (iteration % 2) order.reverse();

      try {
        for (const operation of iteration % 2 ? ['write', 'read'] : ['read', 'write']) {
          for (const variant of order) {
            const name = `${prefix}-${variant}-${operation}`;
            const sample = await invokeCold(lambda, name, versions.get(name), { variant, operation });
            assert.ok(!seen.has(sample.environmentId), 'Lambda execution environment was reused');
            assert.equal(Boolean(sample.trace.execution), metadata.diagnostics, 'The worker must use the requested instrumentation mode');

            if (!metadata.diagnostics) assert.equal(sample.trace.activities, undefined);
            seen.add(sample.environmentId);

            for (const segment of sample.trace.execution?.segments ?? []) {
              if (!sourceIds.has(segment.source)) {
                sourceIds.set(segment.source, data.executionSources.length);
                data.executionSources.push(segment.source);
              }

              segment.sourceId = sourceIds.get(segment.source);
              delete segment.source;
            }

            samples.push({ iteration, batch: Math.min(3, Math.floor(iteration / (count / 4))), ...sample });
            save();
          }
        }
      } finally {
        await Promise.all([...versions].map(([name, version]) => lambda.send(new DeleteFunctionCommand({ FunctionName: name, Qualifier: version }))));
      }
    }
  } catch (error) {
    data.failures.push({ name: error.name, message: error.message });
    save();
    throw error;
  }

  save();
  console.log(`Saved ${samples.length} verified cold Lambda invocations`);

  return data;
}
