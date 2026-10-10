import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { expect, it } from 'vitest';
import { startRelay, tcpPort } from '../../../test/harness/relay.js';

it('forwards bytes, counts sockets, and closes both ends', async () => {
  const target = createServer(socket => socket.pipe(socket));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const relay = await startRelay(tcpPort(target));
  const client = createConnection(relay.port, '127.0.0.1');

  try {
    await once(client, 'connect');
    const reply = once(client, 'data');
    client.write('opaque bytes');
    expect((await reply)[0].toString()).toBe('opaque bytes');
    expect(relay.counts).toEqual({ accepted: 1, open: 1, closed: 0, peak: 1 });
    const closed = once(client, 'close');
    relay.interrupt(1);
    await closed;
    await relay.close();
    expect(relay.counts).toEqual({ accepted: 1, open: 0, closed: 1, peak: 1 });
  } finally {
    client.destroy();
    await relay.close();
    await new Promise<void>(resolve => target.close(() => resolve()));
  }
});

it('holds replies until resumed', async () => {
  const target = createServer(socket => socket.pipe(socket));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const relay = await startRelay(tcpPort(target));
  let client: ReturnType<typeof createConnection> | undefined;

  try {
    relay.pause();
    client = createConnection(relay.port, '127.0.0.1');
    await once(client, 'connect');
    let received = false;
    client.on('data', () => { received = true; });
    client.write('held');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(received).toBe(false);
    const data = once(client, 'data');
    relay.resume();
    await data;
    expect(received).toBe(true);
  } finally {
    client?.destroy();
    await relay.close();
    await new Promise<void>(resolve => target.close(() => resolve()));
  }
});
