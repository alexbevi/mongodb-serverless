import { reportRole } from './harness/handshake.js';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverTopology } from '../src/discovery.js';
import { stubSrvRecords } from '../../test/harness/srv.js';

afterEach(() => vi.restoreAllMocks());

it('uses native SRV and TXT rules before connecting directly with certificate authentication', async () => {
  const uri = 'mongodb+srv://cluster.localhost/app?authMechanism=MONGODB-X509';
  const options = { srvServiceName: 'custom', tlsCertificateKeyFile: '/unused-test-certificate.pem' };
  const status = { set: 'rs0', members: [{ name: 'member.cluster.localhost:27017', stateStr: 'PRIMARY', health: 1 }] };
  const dns = stubSrvRecords(27017, 'authSource=admin&replicaSet=rs0');
  const native = new MongoClient(uri, options);
  const admin = native.db('admin');

  const connect = vi.spyOn(native, 'connect').mockImplementation(async () => {
    reportRole(native, 'RSPrimary', { setName: 'rs0', me: status.members[0]!.name });

    return native;
  });

  const close = vi.spyOn(native, 'close').mockResolvedValue();

  const command = vi.spyOn(admin, 'command')
    .mockResolvedValueOnce(status);

  vi.spyOn(native, 'db').mockReturnValue(admin);

  const createClient = vi.fn((target: string, settings?: MongoClientOptions) => {
    const parsed = new MongoClient(target, settings);

    expect(parsed.options.hosts.map(String)).toEqual(['member.cluster.localhost:27017']);
    expect(parsed.options.directConnection).toBe(true);
    expect(parsed.options.credentials?.source).toBe('$external');
    expect(parsed.options.tlsCertificateKeyFile).toBe(options.tlsCertificateKeyFile);
    expect(parsed.options.tls).toBe(true);

    return native;
  });

  await expect(discoverTopology(uri, createClient, options)).resolves.toEqual({ ...status, authentication: { mechanism: 'MONGODB-X509', source: '$external' } });
  expect(dns).toHaveBeenCalledWith('_custom._tcp.cluster.localhost', 'SRV');
  expect(createClient).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledWith({ replSetGetStatus: 1 });
  expect(close).toHaveBeenCalledTimes(1);
});
