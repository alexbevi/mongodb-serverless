import { isStringProperty } from './property.js';
import { ServerlessDriverError } from './errors.js';

/** Creates the real builder, once the write client is known. */
export type BulkSource = () => Promise<unknown>;

/** Calls on the builder that return it for chaining. */
const CHAINABLE = new Set(['insert', 'raw']);

/** Calls that need the builder to exist. */
const TERMINAL = new Set(['execute']);

/** Readable only once the builder exists. */
const DEFERRED_PROPERTIES = new Set(['length', 'batches', 'isOrdered', 'bsonOptions']);

/** Calls on the object `find()` returns. */
const FIND_OPERATIONS = new Set([
  'delete',
  'deleteOne',
  'replaceOne',
  'update',
  'updateOne',
  'upsert',
  'arrayFilters',
  'collation',
  'hint'
]);

const FIND_MODIFIERS = new Set(['upsert', 'arrayFilters', 'collation', 'hint']);

type Recorded = { path: 'self' | 'find'; method: string; args: unknown[] };

/**
 * A bulk builder that does not exist yet.
 *
 * The driver's builder is stateful and bound to one client, reading options off
 * it at construction. Routing has to await the topology first, so calls are
 * recorded and replayed against the real builder on `execute()`.
 *
 * Bulk writes always go to the primary, so there is no routing decision here,
 * only the ordering problem.
 */
export function createBulkProxy(source: BulkSource, label: string) {
  const recorded: Recorded[] = [];
  let real: Promise<Record<string, unknown>> | undefined;

  const resolve = (): Promise<Record<string, unknown>> => {
    real ??= (async () => {
      const builder = (await source()) as Record<string, unknown>;
      let pendingFind: Record<string, unknown> | undefined;

      for (const { path, method, args } of recorded) {
        if (path === 'find') {
          if (pendingFind == null) {
            throw new ServerlessDriverError(
              `${label}: ${method}() was recorded without a preceding find().`
            );
          }

          const result = apply(pendingFind, method, args, label);
          pendingFind = FIND_MODIFIERS.has(method) ? (result as Record<string, unknown>) : undefined;
          continue;
        }

        const result = apply(builder, method, args, label);

        // find() hands back a sub-builder the next recorded call targets.
        if (method === 'find') pendingFind = result as Record<string, unknown>;
      }

      return builder;
    })();

    return real;
  };

  const findProxy = new Proxy(
    {},
    {
      get(_target, property) {
        if (!isStringProperty(property)) return undefined;

        if (!FIND_OPERATIONS.has(property)) {
          throw new ServerlessDriverError(
            `"${property}" is not available after find() on a routed ${label}. ` +
              'If the mongodb driver added it, it needs to be classified; see AGENTS.md.'
          );
        }

        return (...args: unknown[]) => {
          recorded.push({ path: 'find', method: property, args });

          return FIND_MODIFIERS.has(property) ? findProxy : proxy;
        };
      }
    }
  );

  const proxy = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then' || property === 'catch' || property === 'finally') {
          return undefined;
        }

        if (!isStringProperty(property)) return undefined;

        if (property === 'find') {
          return (...args: unknown[]) => {
            recorded.push({ path: 'self', method: 'find', args });

            return findProxy;
          };
        }

        if (CHAINABLE.has(property)) {
          return (...args: unknown[]) => {
            recorded.push({ path: 'self', method: property, args });

            return proxy;
          };
        }

        if (TERMINAL.has(property)) {
          return async (...args: unknown[]) => {
            const builder = await resolve();

            return apply(builder, property, args, label);
          };
        }

        if (DEFERRED_PROPERTIES.has(property)) {
          throw new ServerlessDriverError(
            `"${property}" is only readable once the ${label} builder exists. Call execute() first.`
          );
        }

        throw new ServerlessDriverError(
          `"${property}" is not available on a routed ${label}. ` +
            'If the mongodb driver added it, it needs to be classified; see AGENTS.md.'
        );
      },

      has(_target, property) {
        return (
          isStringProperty(property) &&
          (property === 'find' || CHAINABLE.has(property) || TERMINAL.has(property))
        );
      }
    }
  );

  return proxy;
}

function apply(
  target: Record<string, unknown>,
  method: string,
  args: unknown[],
  label: string
): unknown {
  const fn = target[method];

  if (typeof fn !== 'function') {
    throw new ServerlessDriverError(`${label}: the mongodb driver has no ${method}() to replay.`);
  }

  return (fn as (...a: unknown[]) => unknown).apply(target, args);
}
