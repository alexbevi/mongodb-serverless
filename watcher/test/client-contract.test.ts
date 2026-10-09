import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('accepts a client implementing the watcher operations and still requires connect', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));

  const result = spawnSync(process.execPath, [
    `${root}/node_modules/typescript/bin/tsc`,
    '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2023', '--module', 'NodeNext',
    `${root}/watcher/test/fixtures/client-contract.ts`,
  ], { cwd: root, encoding: 'utf8' });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
