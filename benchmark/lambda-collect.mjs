import assert from 'node:assert/strict';
import { UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand, PublishVersionCommand, InvokeCommand, DeleteFunctionCommand, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const variants = ['native', 'no-plugin', 'ssm'];

export const workerPatterns = prefix => variants.flatMap(variant => ['read', 'write'].map(operation => ({ name: `${prefix}-${variant}-${operation}`, variant, operation })));

export const workerNames = prefix => workerPatterns(prefix).map(pattern => pattern.name);

export async function invokeCold(lambda, name, version, event) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: name, Qualifier: version, LogType: 'Tail', Payload: Buffer.from(JSON.stringify(event)) }));
  const result = JSON.parse(Buffer.from(response.Payload).toString('utf8'));

  if (response.FunctionError) throw new Error(`Worker failed: ${result.errorType}: ${result.errorMessage}`);
  assert.ok(result.verified && result.cold);
  const log = Buffer.from(response.LogResult ?? '', 'base64').toString('utf8');
  const init = /Init Duration: ([\d.]+) ms/.exec(log);
  const duration = /REPORT[^\n]*\bDuration: ([\d.]+) ms/.exec(log);

  return { ...result, lambda: { version, initMs: init ? Number(init[1]) : null, durationMs: duration ? Number(duration[1]) : null } };
}

export async function collect(lambda, prefix, count, file, metadata) {
  const start = Date.now();
  const names = workerNames(prefix);

  const settings = await Promise.all(names.map(async name => {
    const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));

    return { name, environment: config.Environment.Variables };
  }));

  const samples = [];
  const seen = new Set();
  const data = { createdAt: new Date(start).toISOString(), configuration: { count, batches: 4, readPreference: 'nearest', writes: 'primary / majority', timing: 'SSM fetched during INIT; handler through result; client retained for warm invocations', ...metadata }, samples, executionSources: [], failures: [] };
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
            seen.add(sample.environmentId);

            for (const segment of sample.trace.execution.segments) {
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
