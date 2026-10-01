import { defineConfig } from 'vitest/config';
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
    include: ['{driver,watcher,plugins/*}/test/**/*.test.ts'],
    environment: 'node'
  }
});
