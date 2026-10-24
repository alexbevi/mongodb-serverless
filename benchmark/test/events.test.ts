import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { recordEvents, type DriverEvent } from '../events.js';

type Listeners = ReturnType<typeof recordEvents>['listeners'];

let clock = 0;

const now = () => clock;

const at = (time: number) => { clock = time; };

const recorders: { close(): void }[] = [];

afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.close();
});

function recorder() {
  const recording = recordEvents(now);
  recorders.push(recording);

  return recording;
}

class FakeSocket extends EventEmitter {
  encrypted = true;
  remoteAddress = '10.0.0.1';
  remotePort = 27017;
  authorized = true;
  getProtocol() { return 'TLSv1.3'; }
}

/** Opens a socket the way the driver does: observed through the channel, then its own events. */
function socket(host: string, times: { created: number; lookup: number; connect: number; secure: number; reply: number }) {
  const fake = new FakeSocket();
  at(times.created);
  channel('net.client.socket').publish({ socket: fake });
  at(times.lookup);
  fake.emit('lookup', null, '10.0.0.1', 4, host);
  at(times.connect);
  fake.emit('connect');
  at(times.secure);
  fake.emit('secureConnect');
  at(times.reply);
  fake.emit('data', Buffer.from('reply'));

  return fake;
}

/** Calls a driver listener with the client as `this`, as EventEmitter does. */
function emit(client: EventEmitter, listeners: Listeners, name: keyof Listeners, event: DriverEvent, time: number) {
  at(time);
  listeners[name].call(client, event);
}

it('times an application connection from driver and socket events alone', () => {
  const recording = recorder();
  const client = new EventEmitter();
  const address = 'mongo-a.test:27017';
  recording.reset(0);

  emit(client, recording.listeners, 'connectionCheckOutStarted', { address }, 5);
  emit(client, recording.listeners, 'connectionCreated', { address, connectionId: 1 }, 6);
  socket('mongo-a.test', { created: 7, lookup: 9, connect: 12, secure: 30, reply: 34 });
  emit(client, recording.listeners, 'serverDescriptionChanged', { address, newDescription: { type: 'RSPrimary' } }, 35);
  emit(client, recording.listeners, 'connectionReady', { address, connectionId: 1 }, 41);
  emit(client, recording.listeners, 'connectionCheckedOut', { address, connectionId: 1 }, 42);
  // Command events carry the resolved address rather than the hostname.
  emit(client, recording.listeners, 'commandStarted', { commandName: 'update', requestId: 7, connectionId: 1, address: '10.0.0.1:27017' }, 43);
  emit(client, recording.listeners, 'commandSucceeded', { requestId: 7, connectionId: 1, address: '10.0.0.1:27017' }, 50);

  const trace = recording.trace(51);

  expect(trace.sockets).toEqual([expect.objectContaining({
    kind: 'application', host: 'mongo-a.test', port: 27017, role: 'PRIMARY', authorized: true, protocol: 'TLSv1.3',
    start: 7, lookup: [7, 9], tcp: [9, 12], tls: [12, 30], hello: [30, 34], auth: [34, 41]
  })]);
  expect(trace.checkouts).toEqual([[5, 42]]);
  expect(trace.command).toMatchObject({ name: 'update', start: 43, end: 50, socket: expect.objectContaining({ start: 7 }) });
});

it('separates monitor sockets and attributes discovery to its connection', () => {
  const recording = recorder();
  const client = new EventEmitter();
  const primary = 'mongo-a.test:27017';
  const secondary = 'mongo-b.test:27017';
  recording.reset(0);

  emit(client, recording.listeners, 'serverHeartbeatStarted', { connectionId: primary }, 2);
  socket('mongo-a.test', { created: 3, lookup: 4, connect: 6, secure: 20, reply: 23 });
  emit(client, recording.listeners, 'serverHeartbeatSucceeded', { connectionId: primary, reply: { isWritablePrimary: true } }, 24);
  emit(client, recording.listeners, 'connectionCreated', { address: secondary, connectionId: 1 }, 25);
  socket('mongo-b.test', { created: 26, lookup: 27, connect: 29, secure: 45, reply: 48 });
  emit(client, recording.listeners, 'serverDescriptionChanged', { address: secondary, newDescription: { type: 'RSSecondary' } }, 49);
  emit(client, recording.listeners, 'connectionReady', { address: secondary, connectionId: 1 }, 55);
  emit(client, recording.listeners, 'commandStarted', { commandName: 'replSetGetStatus', requestId: 1, connectionId: 1, address: secondary }, 56);
  emit(client, recording.listeners, 'commandSucceeded', { requestId: 1, connectionId: 1, address: secondary }, 60);
  emit(client, recording.listeners, 'commandStarted', { commandName: 'find', requestId: 2, connectionId: 1, address: secondary }, 61);
  emit(client, recording.listeners, 'commandSucceeded', { requestId: 2, connectionId: 1, address: secondary }, 64);

  const trace = recording.trace(65);

  expect(trace.sockets.map(({ kind, role, host }) => ({ kind, role, host }))).toEqual([
    { kind: 'monitor', role: 'PRIMARY', host: 'mongo-a.test' },
    { kind: 'application', role: 'SECONDARY', host: 'mongo-b.test' }
  ]);
  expect(trace.sockets[0]).not.toHaveProperty('auth');
  expect(trace.sockets[0]).toMatchObject({ hello: [20, 23] });
  expect(trace.commands.map(command => [command.name, command.socket?.host])).toEqual([
    ['replSetGetStatus', 'mongo-b.test'], ['find', 'mongo-b.test']
  ]);
  expect(trace.command).toMatchObject({ name: 'find', start: 61, end: 64 });
});

it('keeps connections from different clients to the same member apart', () => {
  const recording = recorder();
  const discovery = new EventEmitter();
  const routed = new EventEmitter();
  const address = 'mongo-a.test:27017';
  recording.reset(0);

  emit(discovery, recording.listeners, 'connectionCreated', { address, connectionId: 1 }, 1);
  socket('mongo-a.test', { created: 2, lookup: 3, connect: 4, secure: 10, reply: 12 });
  emit(discovery, recording.listeners, 'connectionReady', { address, connectionId: 1 }, 15);
  emit(routed, recording.listeners, 'connectionCreated', { address, connectionId: 1 }, 20);
  socket('mongo-a.test', { created: 21, lookup: 22, connect: 23, secure: 30, reply: 32 });
  emit(routed, recording.listeners, 'connectionReady', { address, connectionId: 1 }, 35);
  emit(routed, recording.listeners, 'commandStarted', { commandName: 'update', requestId: 1, connectionId: 1, address }, 36);
  emit(routed, recording.listeners, 'commandSucceeded', { requestId: 1, connectionId: 1, address }, 40);

  expect(recording.trace(41).command?.socket?.start).toBe(21);
});

it('ignores sockets the driver did not open and events before the measurement', () => {
  const recording = recorder();
  const client = new EventEmitter();
  const address = 'mongo-a.test:27017';

  socket('ssm.amazonaws.com', { created: 1, lookup: 2, connect: 3, secure: 4, reply: 5 });
  recording.reset(10);
  emit(client, recording.listeners, 'connectionCreated', { address, connectionId: 1 }, 11);
  socket('mongo-a.test', { created: 12, lookup: 13, connect: 14, secure: 20, reply: 22 });
  emit(client, recording.listeners, 'connectionReady', { address, connectionId: 1 }, 25);

  expect(recording.trace(30).sockets.map(socket => socket.host)).toEqual(['mongo-a.test']);
});

it('maps a warm command to the socket opened during an earlier measurement', () => {
  const recording = recorder();
  const client = new EventEmitter();
  const address = 'mongo-a.test:27017';
  recording.reset(0);

  emit(client, recording.listeners, 'connectionCreated', { address, connectionId: 1 }, 2);
  socket('mongo-a.test', { created: 3, lookup: 4, connect: 5, secure: 10, reply: 12 });
  emit(client, recording.listeners, 'connectionReady', { address, connectionId: 1 }, 15);
  emit(client, recording.listeners, 'commandStarted', { commandName: 'find', requestId: 1, connectionId: 1, address }, 16);
  emit(client, recording.listeners, 'commandSucceeded', { requestId: 1, connectionId: 1, address }, 18);
  recording.trace(19);

  recording.reset(100);
  emit(client, recording.listeners, 'commandStarted', { commandName: 'find', requestId: 2, connectionId: 1, address }, 101);
  emit(client, recording.listeners, 'commandSucceeded', { requestId: 2, connectionId: 1, address }, 103);
  const warm = recording.trace(104);

  expect(warm.sockets).toEqual([]);
  expect(warm.commands).toHaveLength(1);
  expect(warm.command).toMatchObject({ start: 101, socket: expect.objectContaining({ start: 3, role: 'UNKNOWN' }) });
});
