import { expect, test } from 'vitest';
import { breakdown } from '../metrics.js';

test('accounts for the operation socket without adding parallel discovery sockets', () => {
  const socket: Parameters<typeof breakdown>[2] = { tcp: [2, 5], tls: [5, 9], hello: [10, 12], auth: [12, 16] };
  const result = breakdown(0, 25, socket, { start: 17, sent: 18, end: 24 });

  expect(result).toEqual({ tcp: 3, tls: 4, hello: 2, auth: 4, send: 1, receive: 6, other: 5, total: 25 });
  expect(Object.entries(result).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0)).toBe(result.total);
});
