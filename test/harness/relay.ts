import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

function isTcpAddress(address: ReturnType<Server['address']>): address is AddressInfo {
  return address !== null && typeof address !== 'string';
}

export function tcpPort(server: Server): number {
  const address = server.address();

  if (!isTcpAddress(address)) throw new Error('Expected TCP address');

  return address.port;
}

export async function startRelay(targetPort: number, targetHost = '127.0.0.1') {
  const connections = new Map<number, () => void>();
  const upstreams = new Set<Socket>();
  let paused = false;
  const closing = new Set<Promise<void>>();
  const counts = { accepted: 0, open: 0, closed: 0, peak: 0 };

  const server = createServer(incoming => {
    const id = ++counts.accepted;
    counts.open++;
    counts.peak = Math.max(counts.peak, counts.open);
    const outgoing = createConnection(targetPort, targetHost);
    upstreams.add(outgoing);
    outgoing.once('close', () => upstreams.delete(outgoing));

    const destroy = (): void => {
      incoming.destroy();
      outgoing.destroy();
    };

    connections.set(id, destroy);
    incoming.on('error', destroy);
    outgoing.on('error', destroy);
    const closed = new Promise<void>(resolve => incoming.once('close', resolve));
    closing.add(closed);
    void closed.then(() => closing.delete(closed));
    incoming.once('close', () => {
      outgoing.destroy();
      connections.delete(id);
      counts.open--;
      counts.closed++;
    });
    outgoing.once('close', () => incoming.destroy());
    incoming.pipe(outgoing).pipe(incoming);

    if (paused) outgoing.pause();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: tcpPort(server),
    counts,
    pause(): void {
      paused = true;

      for (const socket of upstreams) socket.pause();
    },
    resume(): void {
      paused = false;

      for (const socket of upstreams) socket.resume();
    },
    interrupt(id: number): void {
      const destroy = connections.get(id);

      if (!destroy) throw new Error(`No open connection ${id}`);
      destroy();
    },
    async close(): Promise<void> {
      const closed = Promise.all(closing);

      for (const destroy of connections.values()) destroy();

      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await closed;
    }
  };
}
