import { createRequire } from 'node:module';
import { UnsupportedOperationError } from '../errors.js';

export const requireMongo = createRequire(createRequire(import.meta.url).resolve('mongodb'));

export function assertVersion(version: string): void {
  if (version !== '7.7.0') {
    throw new UnsupportedOperationError(`disableMonitoring requires mongodb 7.7.0, found ${version}`);
  }
}

export function verifyDriver(): void {
  const manifest: { version: string } = requireMongo('../package.json');
  assertVersion(manifest.version);
}
