import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    alias: {
      '@mongodb-serverless/driver': fileURLToPath(new URL('../../driver/src/index.ts', import.meta.url)),
      '@mongodb-serverless/plugin-aws-ssm': fileURLToPath(new URL('./src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['plugins/aws-ssm/test/localstack.test.ts', 'test/examples/aws-ssm.integration.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 100_000,
    fileParallelism: false
  }
});
