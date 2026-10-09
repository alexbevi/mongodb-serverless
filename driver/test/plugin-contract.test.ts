import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('narrows an untrusted plugin only after structural validation', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));

  const result = spawnSync(process.execPath, [
    `${root}/node_modules/typescript/bin/tsc`,
    '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2023', '--module', 'NodeNext',
    `${root}/driver/test/fixtures/plugin-contract.ts`,
  ], { cwd: root, encoding: 'utf8' });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
