import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('AWS_ENDPOINT_URL_SSM', 'http://127.0.0.1:1');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('does not read SSM while the Lambda module loads', async () => {
  vi.stubEnv('MONGODB_CONNECTION_STRING_PARAMETER', '/example/connection-string');
  vi.stubEnv('MONGODB_TOPOLOGY_PARAMETER', '/example/topology');

  await expect(import('../../examples/aws-ssm/index.js')).resolves.toHaveProperty('handler');
});

it('falls back to the default parameter names when none are set', async () => {
  await expect(import('../../examples/aws-ssm/index.js')).resolves.toHaveProperty('handler');
});
