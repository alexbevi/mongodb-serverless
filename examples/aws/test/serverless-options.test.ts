import { expect, it, vi } from 'vitest';
import { serverlessClientOptions } from '../src/serverless-options.js';

it('enables command events so connection and operation time can be separated', () => {
  expect(serverlessClientOptions(vi.fn())).toMatchObject({
    disableMonitoring: true,
    maxPoolSize: 1,
    minPoolSize: 0,
    monitorCommands: true,
    on: { commandStarted: expect.any(Function) }
  });
});
