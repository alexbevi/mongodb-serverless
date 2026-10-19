import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/localstack.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
});
