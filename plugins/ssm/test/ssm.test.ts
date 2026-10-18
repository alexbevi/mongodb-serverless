import { SSMClient } from '@aws-sdk/client-ssm';
import { expect, it } from 'vitest';
import { SsmPlugin } from '../src/index.js';

const status = { set: 'rs', members: [{ name: 'a:27017', stateStr: 'PRIMARY', health: 1 }] };

it('shares one decrypted parameter request between concurrent URI and topology reads', async () => {
  const requests: string[] = [];

  const client = new SSMClient({
    region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: { async handle(request) {
      requests.push(Buffer.from(request.body).toString('utf8'));

      return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify({
        Parameters: [
          { Name: '/test/topology', Type: 'String', Value: JSON.stringify(status) },
          { Name: '/test/uri', Type: 'SecureString', Value: 'mongodb://user:password@a/db' }
        ]
      })) } };
    } }
  });

  const plugin = new SsmPlugin({ client, connectionStringParameter: '/test/uri', topologyParameter: '/test/topology' });

  try {
    expect(await Promise.all([plugin.getConnectionString(), plugin.read(), plugin.getConnectionString(), plugin.read()]))
      .toEqual(['mongodb://user:password@a/db', status, 'mongodb://user:password@a/db', status]);
    expect(requests.map(text => JSON.parse(text))).toEqual([{ Names: ['/test/uri', '/test/topology'], WithDecryption: true }]);
  } finally {
    client.destroy();
  }
});

it('creates missing topology without rewriting credentials and reuses it on the next instance', async () => {
  const parameters = new Map([['/test/uri', { Name: '/test/uri', Type: 'SecureString', Value: 'mongodb://user:password@a/db' }]]);
  const actions: string[] = [];

  const client = new SSMClient({
    region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: { async handle(request) {
      const action = request.headers['x-amz-target']!.split('.').at(-1)!;
      actions.push(action);
      const input = JSON.parse(Buffer.from(request.body).toString('utf8'));

      if (action === 'PutParameter') {
        expect(input).toMatchObject({ Name: '/test/topology', Type: 'String', Tier: 'Standard', Overwrite: true });
        parameters.set(input.Name, { Name: input.Name, Type: input.Type, Value: input.Value });
      }

      return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(
        action === 'PutParameter' ? { Version: 1 } : { Parameters: [...parameters.values()], InvalidParameters: parameters.has('/test/topology') ? [] : ['/test/topology'] }
      )) } };
    } }
  });

  const options = { client, connectionStringParameter: '/test/uri', topologyParameter: '/test/topology' };
  const plugin = new SsmPlugin(options);
  const discovered = { ...status, authentication: { mechanism: 'SCRAM-SHA-256', source: 'admin' }, debugSecret: 'never persist me' };
  const expected = { ...status, authentication: discovered.authentication };

  try {
    expect(await plugin.read()).toBeNull();
    await plugin.write(discovered);
    expect(await plugin.read()).toEqual(expected);
    expect(await new SsmPlugin(options).read()).toEqual(expected);
    expect(parameters.get('/test/uri')?.Value).toBe('mongodb://user:password@a/db');
    expect(JSON.parse(parameters.get('/test/topology')!.Value)).toEqual(expected);
    expect(actions).toEqual(['GetParameters', 'PutParameter', 'GetParameters']);
  } finally {
    client.destroy();
  }
});
