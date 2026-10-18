import { EventEmitter } from 'node:events';

export function reportRole(client: EventEmitter, type: string): void {
  client.emit('serverDescriptionChanged', { newDescription: { type } });
}

export function handshake(type: string) {
  const events = new EventEmitter();

  return {
    on: events.on.bind(events),
    connected: () => reportRole(events, type)
  };
}
