import { expect, test } from 'vitest';
import { breakdown } from '../metrics.js';

test('accounts for the operation socket without adding parallel discovery sockets', () => {
  const socket: Parameters<typeof breakdown>[2] = { tcp: [2, 5], tls: [5, 9], hello: [10, 12], auth: [12, 16] };
  const result = breakdown(0, 25, socket, { start: 17, sent: 18, end: 24 });

  expect(result).toEqual({ tcp: 3, tls: 4, hello: 2, auth: 4, send: 1, receive: 6, other: 5, total: 25 });
  expect(Object.entries(result).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0)).toBe(result.total);
});

test('matches lifecycle windows by pool, connection and request without treating checkout as extra setup time', async () => {
  const { lifecycleWindows } = await import('../metrics.js');

  const events = [
    { name: 'connectionCheckOutStarted', at: 2, address: 'member:27017' },
    { name: 'connectionCreated', at: 3, address: 'member:27017', connectionId: 1 },
    { name: 'connectionReady', at: 12, address: 'member:27017', connectionId: 1 },
    { name: 'connectionCheckedOut', at: 13, address: 'member:27017', connectionId: 1 },
    { name: 'commandStarted', at: 15, address: '127.0.0.1:27017', connectionId: 1, requestId: 7, commandName: 'find' },
    { name: 'commandSucceeded', at: 16, address: '127.0.0.1:27017', connectionId: 1, requestId: 6, commandName: 'find' },
    { name: 'commandSucceeded', at: 23, address: '127.0.0.1:27017', connectionId: 1, requestId: 7, commandName: 'find' }
  ];

  const command = { name: 'find', start: 14, end: 24, address: '127.0.0.1:27017', connectionId: 1, socket: { host: 'member', port: 27017, start: 4 } };

  expect(lifecycleWindows(command, events, 25)).toEqual({
    connectionSetup: [3, 12], checkouts: [[2, 13]], readyToCommand: [12, 15],
    command: [15, 23], afterCommand: [23, 25]
  });
});

test('counts hostname resolution separately from TCP without double counting', () => {
  const socket = { lookup: [1, 4] as [number, number], tcp: [4, 6] as [number, number], tls: [6, 8] as [number, number], hello: [8, 9] as [number, number], auth: [9, 11] as [number, number] };
  const result = breakdown(0, 15, socket, { start: 12, sent: 13, end: 14 });

  expect(result).toMatchObject({ lookup: 3, tcp: 2, other: 3, total: 15 });
  expect(Object.entries(result).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0)).toBe(15);
});
