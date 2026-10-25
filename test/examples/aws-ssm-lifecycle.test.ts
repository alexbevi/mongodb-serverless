import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('does not read SSM while the Lambda module loads', async () => {
  vi.stubEnv('AWS_ENDPOINT_URL_SSM', 'http://127.0.0.1:1');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1');

  await expect(import('../../examples/aws-lambda/index.js')).resolves.toHaveProperty('handler');
});
