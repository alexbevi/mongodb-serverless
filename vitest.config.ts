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
    include: ['{driver,watcher,plugins/*,benchmark}/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'benchmark/test/live.test.ts'],
    environment: 'node',
    // The driver and watcher integration suites share one replica set, and the
    // watcher's failover test steps down its primary. In parallel that happens
    // underneath the driver's suite, which then writes to a member that is no
    // longer primary and fails with NotWritablePrimary.
    //
    // Serialising every file rather than only those two costs about a second
    // across the unit suites, which do not touch a server.
    fileParallelism: false
  }
});
