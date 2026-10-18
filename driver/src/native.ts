import { createRequire } from 'node:module';
import { UnsupportedOperationError } from './errors.js';

export const requireMongo = createRequire(createRequire(import.meta.url).resolve('mongodb'));

export const MONGODB_BASELINE = [7, 7, 0] as const;

export function assertVersion(version: string): void {
  const release = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(version);
  const major = Number(release?.[1]);
  const minor = Number(release?.[2]);
  const patch = Number(release?.[3]);
  const [baseMajor, baseMinor, basePatch] = MONGODB_BASELINE;
  const stable = release?.[0] === version && [major, minor, patch].every(Number.isSafeInteger);

  const supported = stable && major === baseMajor &&
    (minor > baseMinor || (minor === baseMinor && patch >= basePatch));

  if (!supported) {
    throw new UnsupportedOperationError(
      `MongoDB internals require mongodb >=${MONGODB_BASELINE.join('.')} <${baseMajor + 1}.0.0, found ${version}`
    );
  }
}

