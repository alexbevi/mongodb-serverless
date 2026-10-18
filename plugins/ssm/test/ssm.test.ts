import { SSMClient } from '@aws-sdk/client-ssm';
import { expect, it } from 'vitest';
import { SsmPlugin } from '../src/index.js';

const status = { set: 'rs', members: [{ name: 'a:27017', stateStr: 'PRIMARY', health: 1 }] };

it('shares one decrypted parameter request between concurrent URI and topology reads', async () => {
  const requests: string[] = [];

  const client = new SSMClient({
    region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: { async handle(request) {
      requests.push(String(request.body));

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
