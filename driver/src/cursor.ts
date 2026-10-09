import type { AbstractCursor, ClientSession, MongoClient } from 'mongodb';
import { callMethod } from './method.js';
import { hasProperty, isStringProperty } from './property.js';
import { ServerlessDriverError } from './errors.js';

/** Creates the real cursor, once the routed client is known. */
export type CursorSource<T> = () => Promise<AbstractCursor<T>>;

// The driver exposes these accessors at runtime but omits them from its declarations.
type RuntimeCursor<T> = AbstractCursor<T> & {
  readonly client?: MongoClient;
  readonly session?: ClientSession;
  readonly server?: unknown;
};

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
export function createCursorProxy<T>(source: CursorSource<T>, label: string) {
  const buffered: Array<{ method: string; args: unknown[] }> = [];
  let real: Promise<RuntimeCursor<T>> | undefined;
  let resolved: RuntimeCursor<T> | undefined;

  const resolve = (): Promise<RuntimeCursor<T>> => {
    real ??= (async () => {
      const cursor = await source();

      for (const { method, args } of buffered) {
        callMethod(cursor, method, args, `${label} cursor has no ${method}() to replay.`);
      }

      resolved = cursor;

      return cursor;
    })();

    return real;
  };

  const call = async (method: string, args: unknown[]) => {
    const cursor = await resolve();

    return callMethod(cursor, method, args, `${label} cursor has no ${method}().`);
  };

  const proxy = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === Symbol.asyncIterator) {
          return async function* () {
            yield* await resolve();
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
          if (resolved != null) {
            return hasProperty(resolved, property) ? resolved[property] : undefined;
          }

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

  return proxy;
}
