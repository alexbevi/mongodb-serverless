import { isStringProperty } from './property.js';
import { ServerlessDriverError } from './errors.js';

/** Creates the real cursor, once the routed client is known. */
export type CursorSource = () => Promise<unknown>;

/**
 * Calls that configure a cursor and return it for chaining.
 *
 * Taken from the methods on the driver's cursor classes that return `this`.
 * Event emitter methods are excluded: a listener registered before the cursor
 * exists would attach to nothing.
 */
const CHAINABLE = new Set([
  'addCursorFlag',
  'addQueryModifier',
  'addStage',
  'allowDiskUse',
  'batchSize',
  'collation',
  'comment',
  'filter',
  'hint',
  'limit',
  'map',
  'max',
  'maxAwaitTimeMS',
  'maxTimeMS',
  'min',
  'project',
  'returnKey',
  'showRecordId',
  'skip',
  'sort',
  'withReadConcern',
  'withReadPreference'
]);

/** Calls that need the cursor to exist. Each returns a promise. */
const TERMINAL = new Set([
  'toArray',
  'next',
  'tryNext',
  'hasNext',
  'forEach',
  'explain',
  'count',
  'getMore',
  'clone',
  'rewind',
  'readBufferedDocuments',
  'bufferedCount',
  'stream'
]);

/** Readable only once the cursor exists, so they cannot be answered early. */
const DEFERRED_PROPERTIES = new Set([
  'id',
  'namespace',
  'readPreference',
  'readConcern',
  'closed',
  'killed',
  'session',
  'client',
  'server',
  'loadBalanced'
]);

/**
 * A cursor that does not exist yet.
 *
 * Routing has to await the topology, but `find()` hands back a cursor
 * synchronously. Configuration calls are buffered and replayed against the
 * real cursor when something finally awaits it.
 */
export function createCursorProxy(source: CursorSource, label: string): never {
  const buffered: Array<{ method: string; args: unknown[] }> = [];
  let real: Promise<Record<string, unknown>> | undefined;
  let resolved: Record<string, unknown> | undefined;

  const resolve = (): Promise<Record<string, unknown>> => {
    real ??= (async () => {
      const cursor = (await source()) as Record<string, unknown>;

      for (const { method, args } of buffered) {
        const fn = cursor[method];

        if (typeof fn !== 'function') {
          throw new ServerlessDriverError(`${label} cursor has no ${method}() to replay.`);
        }

        (fn as (...a: unknown[]) => unknown).apply(cursor, args);
      }

      resolved = cursor;

      return cursor;
    })();

    return real;
  };

  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const cursor = await resolve();
    const fn = cursor[method];

    if (typeof fn !== 'function') {
      throw new ServerlessDriverError(`${label} cursor has no ${method}().`);
    }

    return (fn as (...a: unknown[]) => unknown).apply(cursor, args);
  };

  const proxy: object = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === Symbol.asyncIterator) {
          return async function* () {
            yield* (await resolve()) as unknown as AsyncIterable<unknown>;
          };
        }

        // Must not look awaitable: returning the proxy from an async function
        // would otherwise try to unwrap it as a promise.
        if (property === 'then' || property === 'catch' || property === 'finally') {
          return undefined;
        }

        if (!isStringProperty(property)) return undefined;

        if (CHAINABLE.has(property)) {
          return (...args: unknown[]) => {
            buffered.push({ method: property, args });

            return proxy;
          };
        }

        if (TERMINAL.has(property)) {
          return (...args: unknown[]) => call(property, args);
        }

        // Closing a cursor nobody used should not create one to close it.
        if (property === 'close') {
          return async () => {
            if (real != null) await call('close', []);
          };
        }

        if (DEFERRED_PROPERTIES.has(property)) {
          if (resolved != null) return resolved[property];

          throw new ServerlessDriverError(
            `"${property}" is only readable once the ${label} cursor exists. ` +
              'Await a terminal call such as toArray() or next() first.'
          );
        }

        throw new ServerlessDriverError(
          `"${property}" is not available on a routed ${label} cursor. ` +
            'If the mongodb driver added it, it needs to be classified; see AGENTS.md.'
        );
      },

      has(_target, property) {
        return (
          property === Symbol.asyncIterator ||
          (isStringProperty(property) &&
            (CHAINABLE.has(property) || TERMINAL.has(property) || property === 'close'))
        );
      }
    }
  );

  return proxy as never;
}
