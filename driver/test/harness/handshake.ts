import { EventEmitter } from 'node:events';

export function reportRole(client: EventEmitter, type: string, identity: { setName?: string; me?: string } = { setName: 'rs0' }): void {
  client.emit('serverDescriptionChanged', { newDescription: { type, ...identity } });
}

export function handshake(type: string) {
  const events = new EventEmitter();

  return {
    on: events.on.bind(events),
    connected: () => reportRole(events, type)
  };
}
