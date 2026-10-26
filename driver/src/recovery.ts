import type { ClientPair } from './clients.js';

/** Server error codes recovery recognises, by their server names. */
const CODES = {
  ShutdownInProgress: 91,
  PrimarySteppedDown: 189,
  NotWritablePrimary: 10107,
  InterruptedAtShutdown: 11600,
  InterruptedDueToReplStateChange: 11602,
  NotPrimaryNoSecondaryOk: 13435,
  NotPrimaryOrSecondary: 13436
} as const;

/** Every code above means the member's role changed or it is going away. */
const TOPOLOGY_CODES = new Set<number>(Object.values(CODES));

/** The fields recovery reads from a driver error. */
interface DriverError {
  name?: string;
  code?: number;
  errorLabels?: string[];
}

export function isTopologyFailure(error: unknown): error is DriverError {
  return isDriverError(error) && (
    (error.code !== undefined && TOPOLOGY_CODES.has(error.code)) ||
    isTransportFailure(error) ||
    (error.errorLabels?.includes('RetryableWriteError') ?? false) ||
    (error.name === 'MongoBulkWriteError' && 'errorResponse' in error &&
      isDriverError(error.errorResponse) && isTransportFailure(error.errorResponse))
  );
}

function isTransportFailure(error: DriverError): boolean {
  return ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError'].includes(error.name ?? '');
}

export function wasRejectedBeforeWrite(error: unknown): error is DriverError {
  return isDriverError(error) && error.name === 'MongoServerError' &&
    (error.code === CODES.NotWritablePrimary || error.code === CODES.NotPrimaryNoSecondaryOk ||
      (error.errorLabels?.includes('NoWritesPerformed') ?? false));
}

/** Whether a value carries the driver error fields recovery reads, with the expected types. */
function isDriverError(error: unknown): error is DriverError {
  if (error === null || typeof error !== 'object') return false;

  return (!('name' in error) || typeof error.name === 'string') &&
    (!('code' in error) || error.code === undefined || typeof error.code === 'number') &&
    (!('errorLabels' in error) || (Array.isArray(error.errorLabels) && error.errorLabels.every(isString)));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Whether a failed operation may run again after topology is refreshed:
 * only when the server confirms it was rejected before any write, or never,
 * for work whose earlier batches or results may already exist.
 */
export type Replay = 'ifRejectedBeforeWrite' | 'never';

export type WriteOperation = <T>(operation: () => Promise<T>, replay?: Replay) => Promise<T>;

export function createWriteExecutor(resolveClients: () => Promise<ClientPair>): WriteOperation {
  return async (operation, replay = 'ifRejectedBeforeWrite') => {
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

      if (replay === 'never' || !wasRejectedBeforeWrite(error)) throw error;

      return operation();
    }
  };
}
