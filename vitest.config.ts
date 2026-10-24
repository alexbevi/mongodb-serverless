import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (pkg: string): string => fileURLToPath(new URL(`./${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against source, so a suite never passes on a stale dist/ build.
    alias: {
      '@mongodb-serverless/driver': src('driver')
    }
  },
  test: {
    include: ['{driver,plugins/*,benchmark}/test/**/*.test.ts', 'test/examples/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'plugins/*/test/localstack.test.ts',
      'test/examples/aws-ssm.integration.test.ts'
    ],
    environment: 'node',
    // Integration suites share one replica set.
    fileParallelism: false
  }
});
