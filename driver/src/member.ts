import type { MongoClient, ServerType } from 'mongodb';

export interface MemberConnection {
  client: MongoClient;
  type: ServerType;
  setName: string | null;
  host: string | undefined;
}

/** Tracks the role reported by the handshake and subsequent server descriptions. */
export function observeMember(client: MongoClient): MemberConnection {
  const member: MemberConnection = { client, type: 'Unknown', setName: null, host: undefined };
  client.on('serverDescriptionChanged', ({ newDescription }) => {
    member.type = newDescription.type;
    member.setName = newDescription.setName;
    member.host = newDescription.me ?? newDescription.address;
  });

  return member;
}
