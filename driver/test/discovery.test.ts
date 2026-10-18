import { MongoClient, type MongoClientOptions } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { discoverTopology } from '../src/discovery.js';

it('passes the original SRV URI and authentication options to native discovery', async () => {
  const uri = 'mongodb+srv://cluster.example.com/app?authMechanism=MONGODB-X509';
  const options = { srvServiceName: 'custom', tlsCertificateKeyFile: '/unused-test-certificate.pem' };
  const status = { set: 'rs0', members: [{ name: 'node.example.com:27017', stateStr: 'PRIMARY', health: 1 }] };
  const native = new MongoClient(uri, options);
  const admin = native.db('admin');
  const connect = vi.spyOn(native, 'connect').mockResolvedValue(native);
  const close = vi.spyOn(native, 'close').mockResolvedValue();

  const command = vi.spyOn(admin, 'command')
    .mockResolvedValueOnce({ setName: 'rs0' })
    .mockResolvedValueOnce(status);

  vi.spyOn(native, 'db').mockReturnValue(admin);

  const createClient = vi.fn((target: string, settings?: MongoClientOptions) => {
    expect(target).toBe(uri);
    expect(settings?.directConnection).not.toBe(true);

    const parsed = new MongoClient(target, settings);

    expect(parsed.options.srvHost).toBe('cluster.example.com');
    expect(parsed.options.srvServiceName).toBe('custom');
    expect(parsed.options.credentials?.source).toBe('$external');
    expect(parsed.options.tlsCertificateKeyFile).toBe(options.tlsCertificateKeyFile);

    return native;
  });

  await expect(discoverTopology(uri, createClient, options)).resolves.toEqual({ ...status, authentication: { mechanism: 'MONGODB-X509', source: '$external' } });
  expect(createClient).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenNthCalledWith(1, { hello: 1 });
  expect(command).toHaveBeenNthCalledWith(2, { replSetGetStatus: 1 });
  expect(close).toHaveBeenCalledTimes(1);
});
