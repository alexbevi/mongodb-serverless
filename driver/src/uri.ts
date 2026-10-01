import { ConnectionString } from 'mongodb-connection-string-url';
import { ServerlessDriverError } from './errors.js';

/** Options that cannot survive a rewrite to a single-host direct connection. */
const INCOMPATIBLE = ['replicaSet', 'srvMaxHosts', 'srvServiceName'];

/**
 * Rewrites a connection string to connect directly to one member.
 *
 * Everything the user supplied is preserved except the host list and the
 * options that a direct connection rejects. `mongodb+srv://` becomes
 * `mongodb://`, which means losing the TLS that SRV turns on implicitly, so
 * `tls=true` is written back explicitly unless the user already chose.
 *
 * @param uri The user's original connection string.
 * @param hostPort The member to target, as `host:port`.
 */
export function directUri(uri: string, hostPort: string): string {
  const original = new ConnectionString(uri);
  const rewritten = original.clone();

  // The driver rejects loadBalanced with directConnection, so routing a
  // load-balanced cluster this way cannot work.
  if (rewritten.searchParams.get('loadBalanced') === 'true') {
    throw new ServerlessDriverError(
      'loadBalanced cannot combine with directConnection, so this cluster cannot be routed. ' +
        'Load-balanced clusters are not supported.'
    );
  }

  const srvImpliedTls = original.isSRV && !hasAnyOf(original, ['tls', 'ssl']);

  if (original.isSRV) {
    rewritten.protocol = 'mongodb:';
  }

  rewritten.hosts = [hostPort];

  for (const option of INCOMPATIBLE) {
    rewritten.searchParams.delete(option);
  }

  if (srvImpliedTls) {
    rewritten.searchParams.set('tls', 'true');
  }

  rewritten.searchParams.set('directConnection', 'true');

  return rewritten.toString();
}

function hasAnyOf(url: ConnectionString, options: string[]): boolean {
  return options.some(option => url.searchParams.has(option));
}
