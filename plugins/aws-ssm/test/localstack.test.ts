import { DeleteParametersCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { SsmPlugin } from '../src/index.js';

const endpoint = process.env['SSM_ENDPOINT'];

if (!endpoint) throw new Error('Set SSM_ENDPOINT to the LocalStack endpoint before running these integration tests');

const settings = {
  endpoint, region: 'us-east-1', maxAttempts: 1,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
};

const store = new SSMClient(settings);

const client = new SSMClient(settings);

const requests: { command: string; input: unknown }[] = [];

client.middlewareStack.add((next, context) => async args => {
  requests.push({ command: context.commandName ?? '', input: args.input });

  return next(args);
}, { step: 'initialize', name: 'recordPluginRequests' });

const uri = 'mongodb://user:localstack-test-secret@primary:27017/app';

const topology = {
  set: 'rs',
  members: [
    { name: 'primary:27017', stateStr: 'PRIMARY', health: 1 },
    { name: 'secondary:27017', stateStr: 'SECONDARY', health: 1 }
  ],
  authentication: { mechanism: 'SCRAM-SHA-256', source: 'admin' }
};

let connectionStringParameter: string;

let topologyParameter: string;

beforeEach(() => {
  const prefix = `/plugin-aws-ssm/${randomUUID()}`;

  connectionStringParameter = `${prefix}/z-uri`;
  topologyParameter = `${prefix}/a-topology`;
  requests.length = 0;
});

afterEach(async () => {
  await store.send(new DeleteParametersCommand({ Names: [connectionStringParameter, topologyParameter] }));
});

afterAll(() => {
  client.destroy();
  store.destroy();
});

const plugin = (writable = true) => new SsmPlugin({ client, connectionStringParameter, topologyParameter, writable });

const putUri = (value = uri, type: 'SecureString' | 'String' = 'SecureString') => store.send(new PutParameterCommand({
  Name: connectionStringParameter, Type: type, Value: value, Overwrite: true
}));

const putTopology = (value: string) => store.send(new PutParameterCommand({
  Name: topologyParameter, Type: 'String', Value: value, Overwrite: true
}));

it('decrypts the URI and fetches topology in one shared GetParameters request', async () => {
  await putUri();
  await putTopology(JSON.stringify(topology));

  const encrypted = await store.send(new GetParameterCommand({ Name: connectionStringParameter, WithDecryption: false }));

  expect(encrypted.Parameter?.Type).toBe('SecureString');
  expect(encrypted.Parameter?.Value).toBeTruthy();
  expect(encrypted.Parameter?.Value).not.toBe(uri);

  const current = plugin();

  expect(await Promise.all([current.getConnectionString(), current.read(), current.getConnectionString(), current.read()]))
    .toEqual([uri, topology, uri, topology]);
  expect(requests).toEqual([{
    command: 'GetParametersCommand',
    input: { Names: [connectionStringParameter, topologyParameter], WithDecryption: true }
  }]);
});

it('creates and refreshes topology for subsequent instances without changing the SecureString', async () => {
  await putUri();

  const current = plugin();

  expect(await current.read()).toBeNull();
  await current.write({ ...topology, debugSecret: 'must not be stored' });
  expect(await current.read()).toEqual(topology);
  expect(await plugin().read()).toEqual(topology);

  const refreshed = { ...topology, members: [...topology.members].reverse().map((member, index) => ({
    ...member, stateStr: index === 0 ? 'PRIMARY' : 'SECONDARY'
  })) };

  await current.write(refreshed);
  expect(await current.read()).toEqual(refreshed);
  expect(await plugin().read()).toEqual(refreshed);
  expect(requests.map(request => request.command)).toEqual([
    'GetParametersCommand', 'PutParameterCommand', 'GetParametersCommand', 'PutParameterCommand', 'GetParametersCommand'
  ]);

  const storedTopology = await store.send(new GetParameterCommand({ Name: topologyParameter }));
  const storedUri = await store.send(new GetParameterCommand({ Name: connectionStringParameter, WithDecryption: true }));

  expect(storedTopology.Parameter).toMatchObject({ Type: 'String', Version: 2 });
  expect(JSON.parse(storedTopology.Parameter!.Value!)).toEqual(refreshed);
  expect(storedUri.Parameter).toMatchObject({ Type: 'SecureString', Value: uri, Version: 1 });
});

it.each(['missing', 'plaintext'])('rejects a %s connection string', async kind => {
  if (kind === 'plaintext') await putUri(uri, 'String');

  await expect(plugin().getConnectionString()).rejects.toThrow('must contain a SecureString connection string');
  expect(requests.map(request => request.command)).toEqual(['GetParametersCommand']);
});

it('retries a failed load on the same instance after the parameter is created', async () => {
  const current = plugin();

  await expect(current.read()).rejects.toThrow('must contain a SecureString connection string');
  await putUri();
  expect(await current.getConnectionString()).toBe(uri);
  expect(await current.read()).toBeNull();
  expect(requests.map(request => request.command)).toEqual(['GetParametersCommand', 'GetParametersCommand']);
});

it('reloads rotated credentials only in a new instance', async () => {
  await putUri();

  const current = plugin();
  const rotated = 'mongodb://user:rotated-test-secret@primary:27017/app';

  expect(await current.getConnectionString()).toBe(uri);
  await putUri(rotated);
  expect(await current.getConnectionString()).toBe(uri);
  expect(await plugin().getConnectionString()).toBe(rotated);
  expect(requests.map(request => request.command)).toEqual(['GetParametersCommand', 'GetParametersCommand']);
});

it('rejects malformed topology and reloads after it is repaired', async () => {
  await putUri();
  await putTopology('{invalid-json');

  const current = plugin();

  await expect(current.read()).rejects.toThrow();
  await putTopology(JSON.stringify(topology));
  expect(await current.read()).toEqual(topology);
  expect(requests.map(request => request.command)).toEqual(['GetParametersCommand', 'GetParametersCommand']);
});

it('keeps read-only topology unchanged without sending PutParameter', async () => {
  await putUri();
  await putTopology(JSON.stringify(topology));

  const current = plugin(false);

  expect(await current.read()).toEqual(topology);
  await expect(current.write(topology)).rejects.toMatchObject({ name: 'PluginReadOnlyError' });
  expect(requests.map(request => request.command)).toEqual(['GetParametersCommand']);

  const stored = await store.send(new GetParameterCommand({ Name: topologyParameter }));

  expect(stored.Parameter?.Version).toBe(1);
});

it('rejects topology larger than the Standard parameter limit without changing stored topology', async () => {
  await putUri();
  await putTopology(JSON.stringify(topology));

  const current = plugin();

  expect(await current.read()).toEqual(topology);
  await expect(current.write({ ...topology, set: 'x'.repeat(4096) })).rejects.toThrow('4096 bytes');
  expect(requests.map(request => request.command)).toEqual(['GetParametersCommand']);

  const stored = await store.send(new GetParameterCommand({ Name: topologyParameter }));

  expect(stored.Parameter?.Version).toBe(1);
});
