import type { ClientPair } from './clients.js';

const TOPOLOGY_CODES = new Set([91, 189, 10107, 11600, 11602, 13435, 13436]);

interface WriteFailure {
  name?: string;
  code?: number;
  errorLabels?: string[];
}

export function isTopologyFailure(error: unknown): error is WriteFailure {
  return isWriteFailure(error) && (
    (error.code !== undefined && TOPOLOGY_CODES.has(error.code)) ||
    ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError'].includes(error.name ?? '') ||
    (error.errorLabels?.includes('RetryableWriteError') ?? false)
  );
}

export function wasRejectedBeforeWrite(error: unknown): error is WriteFailure {
  return isWriteFailure(error) && error.name === 'MongoServerError' &&
    (error.code === 10107 || error.code === 13435 ||
      (error.errorLabels?.includes('NoWritesPerformed') ?? false));
}

function isWriteFailure(error: unknown): error is WriteFailure {
  if (error === null || typeof error !== 'object') return false;

  return (!('name' in error) || typeof error.name === 'string') &&
    (!('code' in error) || typeof error.code === 'number') &&
    (!('errorLabels' in error) || (Array.isArray(error.errorLabels) && error.errorLabels.every(isString)));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export type WriteOperation = <T>(operation: () => Promise<T>, replay?: boolean) => Promise<T>;

export function createWriteExecutor(resolveClients: () => Promise<ClientPair>): WriteOperation {
  return async (operation, replay = true) => {
    const clients = await resolveClients();
    const generation = clients.generation;

    try {
      return await operation();
    } catch (error) {
      if (!isTopologyFailure(error)) throw error;

      try {
        await clients.refreshTopology(generation);
      } catch {
        // Preserve the write failure when recovery itself fails.
        throw error;
      }

      if (!replay || !wasRejectedBeforeWrite(error)) throw error;

      return operation();
    }
  };
}
