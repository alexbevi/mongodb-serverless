import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['benchmark/test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false
  }
});
