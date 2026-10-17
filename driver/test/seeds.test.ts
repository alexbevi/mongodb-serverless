import { expect, it } from 'vitest';
import { resolveSeeds } from '../src/seeds.js';

it('resolves SRV and TXT without losing TLS, credentials, or explicit URI options', async () => {
  const queries: string[] = [];
  const result = await resolveSeeds('mongodb+srv://user:secret@cluster.example.com/app', {
    async resolveSrv(name) {
      queries.push(name);

      return [{ name: 'node.example.com', port: 27018, priority: 0, weight: 0 }];
    },
    async resolveTxt() { return [['authSource=admin&replicaSet=rs0']]; }
  });

  expect(queries).toEqual(['_mongodb._tcp.cluster.example.com']);
  expect(result.hosts).toEqual(['node.example.com:27018']);
  expect(result.uri).toContain('user:secret@');
  expect(result.uri).toContain('authSource=admin');
  expect(result.uri).toContain('tls=true');
});
