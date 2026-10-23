import { DeleteParametersCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeCluster, startCluster, stopCluster } from '../harness/cluster.js';

const endpoint = process.env['SSM_ENDPOINT'];

if (!endpoint) throw new Error('Set SSM_ENDPOINT to the LocalStack endpoint before running this integration test');

const connectionStringParameter = '/mongodb-serverless/connection-string';

const topologyParameter = '/mongodb-serverless/topology';

const settings = {
  endpoint, region: 'us-east-1', maxAttempts: 1,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
};

Object.assign(process.env, {
  AWS_ENDPOINT_URL_SSM: endpoint,
  AWS_REGION: settings.region,
  AWS_ACCESS_KEY_ID: settings.credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: settings.credentials.secretAccessKey,
  MONGODB_DATABASE: 'example_integration',
  MONGODB_COLLECTION: 'documents'
});

const ssm = new SSMClient(settings);

let handler: typeof import('../../examples/aws-ssm/index.js').handler;

beforeAll(async () => {
  await startCluster();
  const cluster = await describeCluster();

  await ssm.send(new DeleteParametersCommand({ Names: [connectionStringParameter, topologyParameter] }));
  await ssm.send(new PutParameterCommand({
    Name: connectionStringParameter,
    Type: 'SecureString',
    Value: cluster.uri,
    Overwrite: true
  }));

  handler = (await import('../../examples/aws-ssm/index.js')).handler;

  await ssm.send(new DeleteParametersCommand({ Names: [connectionStringParameter] }));
}, 90_000);

afterAll(async () => {
  await ssm.send(new DeleteParametersCommand({ Names: [connectionStringParameter, topologyParameter] }));
  ssm.destroy();
  await stopCluster();
});

it('uses INIT settings in the actual Lambda handler against LocalStack and MongoDB', async () => {
  const saved = await handler(event('/save', { body: JSON.stringify({ _id: 'example', value: 'stored' }) }));

  expect(saved.statusCode).toBe(200);

  await expect.poll(async () => {
    const found = await handler(event('/find', { queryStringParameters: { id: 'example' } }));

    return { statusCode: found.statusCode, body: JSON.parse(found.body) };
  }).toEqual({ statusCode: 200, body: { _id: 'example', value: 'stored' } });

  const topology = await ssm.send(new GetParameterCommand({ Name: topologyParameter }));

  expect(JSON.parse(topology.Parameter?.Value ?? '{}')).toMatchObject({
    set: 'rstest',
    members: expect.arrayContaining([
      expect.objectContaining({ stateStr: 'PRIMARY' }),
      expect.objectContaining({ stateStr: 'SECONDARY' })
    ])
  });
});

function event(
  rawPath: string,
  overrides: Partial<APIGatewayProxyEventV2> = {}
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: 'test', apiId: 'test', domainName: 'localhost', domainPrefix: 'test',
      http: { method: rawPath === '/save' ? 'POST' : 'GET', path: rawPath, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: 'test', routeKey: '$default', stage: '$default', time: 'now', timeEpoch: 0
    },
    isBase64Encoded: false,
    ...overrides
  };
}
