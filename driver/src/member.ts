import type { MongoClient } from 'mongodb';

export interface MemberConnection {
  client: MongoClient;
  type: string;
}

/** Tracks the role reported by the handshake and subsequent server descriptions. */
export function observeMember(client: MongoClient): MemberConnection {
  const member = { client, type: 'Unknown' };
  client.on('serverDescriptionChanged', event => { member.type = event.newDescription.type; });

  return member;
}
