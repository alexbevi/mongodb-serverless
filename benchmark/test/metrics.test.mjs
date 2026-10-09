import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown } from '../metrics.mjs';

test('accounts for the operation socket without adding parallel discovery sockets', () => {
  const socket = { tcp: [2, 5], tls: [5, 9], hello: [10, 12], auth: [12, 16] };
  const result = breakdown(0, 25, socket, { start: 17, sent: 18, end: 24 });
  assert.deepEqual(result, { tcp: 3, tls: 4, hello: 2, auth: 4, send: 1, receive: 6, other: 5, total: 25 });
  assert.equal(Object.entries(result).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0), result.total);
});
