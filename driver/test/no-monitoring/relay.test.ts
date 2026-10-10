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
