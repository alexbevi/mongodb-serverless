import assert from 'node:assert/strict';
import type { SocketTrace, CommandTrace, Interval, RecordedCommand, LifecycleEvent } from './types.js';

export function breakdown(start: number, end: number, socket: Pick<SocketTrace, 'lookup' | 'tcp' | 'tls' | 'hello' | 'auth'>, command: Pick<CommandTrace, 'start' | 'sent' | 'end'>) {
  const duration = (interval: Interval | undefined): number => {
    assert.ok(interval, 'Missing timing interval');

    return interval[1] - interval[0];
  };

  assert.ok(command.sent !== undefined && command.end !== undefined, 'Incomplete command trace');

  const phases: Record<'tcp' | 'tls' | 'hello' | 'auth' | 'send' | 'receive', number> & { lookup?: number } = {
    tcp: duration(socket.tcp), tls: duration(socket.tls),
    hello: duration(socket.hello), auth: duration(socket.auth),
    send: command.sent - command.start, receive: command.end - command.sent
  };

  if (socket.lookup) phases.lookup = duration(socket.lookup);

  const total = end - start;
  const other = total - Object.values(phases).reduce((sum, value) => sum + value, 0);

  if ([...Object.values(phases), other].some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid or overlapping benchmark timing intervals');
  }

  return { ...phases, other, total };
}

export function lifecycleWindows(command: RecordedCommand, events: LifecycleEvent[], end: number) {
  const poolAddress = `${command.socket.host}:${command.socket.port}`;
  const pool = events.filter(event => event.address === poolAddress);
  const created = pool.find(event => event.name === 'connectionCreated' && event.connectionId === command.connectionId);
  const ready = pool.find(event => event.name === 'connectionReady' && event.connectionId === command.connectionId);
  const started = events.find(event => event.name === 'commandStarted' && event.address === command.address && event.connectionId === command.connectionId && event.commandName === command.name && event.at >= command.start);
  const completed = events.find(event => event.name === 'commandSucceeded' && event.address === command.address && event.connectionId === command.connectionId && event.requestId === started?.requestId);

  assert.ok(created && ready && started && completed, 'Missing operation lifecycle events');
  const checkouts: Interval[] = [];
  let checkoutStart: number | undefined;

  for (const event of pool) {
    if (event.name === 'connectionCheckOutStarted') {
      assert.equal(checkoutStart, undefined, 'Checkout matching requires serial operations per pool');
      checkoutStart = event.at;
    } else if (event.name === 'connectionCheckedOut' || event.name === 'connectionCheckOutFailed') {
      assert.ok(checkoutStart !== undefined, 'Missing checkout start');

      if (event.connectionId === command.connectionId && event.at <= started.at) checkouts.push([checkoutStart, event.at]);
      checkoutStart = undefined;
    }
  }

  assert.ok(checkouts.length > 0, 'Missing operation checkout');

  const windows = {
    connectionSetup: [created.at, ready.at],
    checkouts,
    readyToCommand: [ready.at, started.at],
    command: [started.at, completed.at],
    afterCommand: [completed.at, end]
  } satisfies { connectionSetup: Interval; checkouts: Interval[]; readyToCommand: Interval; command: Interval; afterCommand: Interval };

  for (const [begin, finish] of [windows.connectionSetup, ...checkouts, windows.readyToCommand, windows.command, windows.afterCommand]) {
    assert.ok(Number.isFinite(begin) && Number.isFinite(finish) && finish >= begin, 'Invalid lifecycle interval');
  }

  return windows;
}
