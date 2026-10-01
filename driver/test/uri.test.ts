import { describe, expect, it } from 'vitest';
import { ConnectionString } from 'mongodb-connection-string-url';
import { directUri } from '../src/uri.js';
import { ServerlessDriverError } from '../src/errors.js';

const parse = (uri: string) => new ConnectionString(uri);

describe('directUri', () => {
  it('targets the given host with directConnection', () => {
    const url = parse(directUri('mongodb://a:27017,b:27017/', 'b:27017'));

    expect(url.hosts).toEqual(['b:27017']);
    expect(url.searchParams.get('directConnection')).toBe('true');
  });

  it('collapses a multi-seed host list to one host', () => {
    const url = parse(directUri('mongodb://a:27017,b:27017,c:27017/', 'c:27017'));

    expect(url.hosts).toHaveLength(1);
  });

  it('preserves credentials', () => {
    const url = parse(directUri('mongodb://user:pass@a:27017/', 'a:27017'));

    expect(url.username).toBe('user');
    expect(url.password).toBe('pass');
  });

  it('preserves percent-encoded credentials verbatim', () => {
    const uri = directUri('mongodb://user:p%40ss%3Aword@a:27017/', 'a:27017');

    expect(uri).toContain('p%40ss%3Aword');
    expect(parse(uri).password).toBe('p%40ss%3Aword');
  });

  it('preserves the auth database in the path', () => {
    const url = parse(directUri('mongodb://a:27017/mydb', 'a:27017'));

    expect(url.pathname).toBe('/mydb');
  });

  it('preserves unrelated options', () => {
    const url = parse(
      directUri('mongodb://a:27017/?appName=svc&authSource=admin&compressors=zstd', 'a:27017')
    );

    expect(url.searchParams.get('appName')).toBe('svc');
    expect(url.searchParams.get('authSource')).toBe('admin');
    expect(url.searchParams.get('compressors')).toBe('zstd');
  });

  it('strips replicaSet, which conflicts with a direct connection', () => {
    const url = parse(directUri('mongodb://a:27017/?replicaSet=rs0', 'a:27017'));

    expect(url.searchParams.has('replicaSet')).toBe(false);
  });

  it('rewrites mongodb+srv to a plain scheme', () => {
    const url = parse(directUri('mongodb+srv://cluster.example.net/', 'a:27017'));

    expect(url.protocol).toBe('mongodb:');
    expect(url.isSRV).toBe(false);
  });

  it('keeps TLS on when rewriting mongodb+srv, which implies it', () => {
    const url = parse(directUri('mongodb+srv://cluster.example.net/', 'a:27017'));

    expect(url.searchParams.get('tls')).toBe('true');
  });

  it('respects tls=false set explicitly on an srv uri', () => {
    const url = parse(directUri('mongodb+srv://cluster.example.net/?tls=false', 'a:27017'));

    expect(url.searchParams.get('tls')).toBe('false');
  });

  it('respects ssl=false set explicitly on an srv uri', () => {
    const url = parse(directUri('mongodb+srv://cluster.example.net/?ssl=false', 'a:27017'));

    expect(url.searchParams.has('tls')).toBe(false);
    expect(url.searchParams.get('ssl')).toBe('false');
  });

  it('does not add tls to a plain mongodb uri', () => {
    const url = parse(directUri('mongodb://a:27017/', 'a:27017'));

    expect(url.searchParams.has('tls')).toBe(false);
  });

  it('strips srv-only options when rewriting', () => {
    const url = parse(
      directUri('mongodb+srv://cluster.example.net/?srvMaxHosts=2&srvServiceName=mongo', 'a:27017')
    );

    expect(url.searchParams.has('srvMaxHosts')).toBe(false);
    expect(url.searchParams.has('srvServiceName')).toBe(false);
  });

  it('rejects loadBalanced, which cannot combine with directConnection', () => {
    expect(() => directUri('mongodb://a:27017/?loadBalanced=true', 'a:27017')).toThrow(
      ServerlessDriverError
    );
  });

  it('names loadBalanced in the error', () => {
    expect(() => directUri('mongodb://a:27017/?loadBalanced=true', 'a:27017')).toThrow(
      /loadBalanced/
    );
  });

  it('allows loadBalanced=false', () => {
    expect(() => directUri('mongodb://a:27017/?loadBalanced=false', 'a:27017')).not.toThrow();
  });

  it('overrides a user-supplied directConnection=false', () => {
    const url = parse(directUri('mongodb://a:27017/?directConnection=false', 'a:27017'));

    expect(url.searchParams.get('directConnection')).toBe('true');
  });

  it('handles a bracketed IPv6 target', () => {
    const url = parse(directUri('mongodb://a:27017/', '[::1]:27017'));

    expect(url.hosts).toEqual(['[::1]:27017']);
  });

  it('produces a uri the driver itself accepts', async () => {
    const { MongoClient } = await import('mongodb');
    const uri = directUri('mongodb+srv://user:pass@cluster.example.net/db?appName=svc', 'b:27017');
    const client = new MongoClient(uri);

    expect(client.options.hosts.map(String)).toEqual(['b:27017']);
    expect(client.options.directConnection).toBe(true);
    expect(client.options.tls).toBe(true);
    expect(client.options.appName).toBe('svc');
  });
});
