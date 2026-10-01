import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{driver,watcher,plugins/*}/test/**/*.test.ts'],
    environment: 'node'
  }
});
