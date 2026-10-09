import assert from 'node:assert/strict';
import type { SocketTrace, CommandTrace, Interval } from './types.js';

export function breakdown(start: number, end: number, socket: Pick<SocketTrace, 'tcp' | 'tls' | 'hello' | 'auth'>, command: Pick<CommandTrace, 'start' | 'sent' | 'end'>) {
  const duration = (interval: Interval | undefined): number => {
    assert.ok(interval, 'Missing timing interval');
    return interval[1] - interval[0];
  };
  assert.ok(command.sent !== undefined && command.end !== undefined, 'Incomplete command trace');
  const phases = {
    tcp: duration(socket.tcp), tls: duration(socket.tls),
    hello: duration(socket.hello), auth: duration(socket.auth),
    send: command.sent - command.start, receive: command.end - command.sent
  };
  const total = end - start;
  const other = total - Object.values(phases).reduce((sum, value) => sum + value, 0);
  if ([...Object.values(phases), other].some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid or overlapping benchmark timing intervals');
  }
  return { ...phases, other, total };
}
