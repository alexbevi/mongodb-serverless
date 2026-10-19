import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('loads the built plugin through its published package name', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { SsmPlugin } from '@mongodb-serverless/plugin-aws-ssm';
    const plugin = new SsmPlugin();
    console.log(JSON.stringify({ name: plugin.name, writable: plugin.writable }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  expect(JSON.parse(output)).toEqual({ name: 'AWS SSM Parameter Store', writable: true });
});
