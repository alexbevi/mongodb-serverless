import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo, type Server } from 'node:net';

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
  const counts = { accepted: 0, open: 0, closed: 0, peak: 0 };

  const server = createServer(incoming => {
    const id = ++counts.accepted;
    counts.open++;
    counts.peak = Math.max(counts.peak, counts.open);
    const outgoing = createConnection(targetPort, targetHost);

    const destroy = (): void => {
      incoming.destroy();
      outgoing.destroy();
    };

    connections.set(id, destroy);
    incoming.on('error', destroy);
    outgoing.on('error', destroy);
    incoming.once('close', () => {
      outgoing.destroy();
      connections.delete(id);
      counts.open--;
      counts.closed++;
    });
    outgoing.once('close', () => incoming.destroy());
    incoming.pipe(outgoing).pipe(incoming);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: tcpPort(server),
    counts,
    interrupt(id: number): void {
      const destroy = connections.get(id);

      if (!destroy) throw new Error(`No open connection ${id}`);
      destroy();
    },
    async close(): Promise<void> {
      for (const destroy of connections.values()) destroy();

      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
