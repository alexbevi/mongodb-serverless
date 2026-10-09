import { callMethod } from './method.js';
import { isStringProperty } from './property.js';
import type { Collection, Db, MongoClient } from 'mongodb';
import {
  ServerlessDriverError,
  SessionRoutingError,
  UnsupportedOperationError
} from './errors.js';
import { COLLECTION_ROUTES, DB_ROUTES, routeFor, type Route } from './routing.js';
import { createCursorProxy } from './cursor.js';
import { createBulkProxy } from './bulk.js';

/**
 * Methods that hand back a cursor synchronously, so they cannot await the
 * topology. Each returns a lazy cursor proxy instead.
 */
const CURSOR_METHODS = new Set([
  'find',
  'aggregate',
  'listIndexes',
  'listSearchIndexes',
  'listCollections',
  'runCursorCommand'
]);

/** Methods returning a stateful bulk builder, also synchronously. */
const BULK_METHODS = new Set(['initializeOrderedBulkOp', 'initializeUnorderedBulkOp']);

/** Hands back the client an operation should run on. */
export interface Router {
  read(): Promise<MongoClient>;
  write(): Promise<MongoClient>;
}

type Routes = Record<string, Route | 'pipeline'>;

/** Resolves the real object a call delegates to, once its client is known. */
type Owner = (client: MongoClient) => Db | Collection;

export function createDbFacade(router: Router, dbName: string): Db {
  const local = new Map([['databaseName', dbName], ['namespace', dbName]]);
  const owner: Owner = client => client.db(dbName);

  // SAFETY: The proxy implements classified Db operations and rejects unsupported members.
  return new Proxy({} as Db, {
    get(_target, property) {
      if (!isStringProperty(property)) return undefined;

      if (local.has(property)) return local.get(property);

      if (property === 'collection') {
        return (name: string) => createCollectionFacade(router, dbName, name);
      }

      return routedMethod(router, DB_ROUTES, property, owner);
    },

    has(_target, property) {
      return isStringProperty(property) && (local.has(property) || property in DB_ROUTES);
    }
  });
}

export function createCollectionFacade(router: Router, dbName: string, name: string): Collection {
  const local = new Map([
    ['collectionName', name],
    ['dbName', dbName],
    ['namespace', `${dbName}.${name}`]
  ]);

  const owner: Owner = client => client.db(dbName).collection(name);

  // SAFETY: The proxy implements classified Collection operations and rejects unsupported members.
  return new Proxy({} as Collection, {
    get(_target, property) {
      if (!isStringProperty(property)) return undefined;

      if (local.has(property)) return local.get(property);

      return routedMethod(router, COLLECTION_ROUTES, property, owner);
    },

    has(_target, property) {
      return isStringProperty(property) && (local.has(property) || property in COLLECTION_ROUTES);
    }
  });
}

/**
 * Delegates one classified method to the routed client.
 *
 * Routing needs the topology, which means awaiting it, so every routed call
 * returns a promise. Methods that hand back a cursor or a bulk builder
 * synchronously use deferred proxies instead.
 */
function routedMethod(router: Router, routes: Routes, method: string, owner: Owner) {
  if (!(method in routes)) {
    throw new ServerlessDriverError(
      `"${method}" is not a routable operation on this proxy. ` +
        'If the mongodb driver added it, it needs a routing rule; see AGENTS.md.'
    );
  }

  return (...args: unknown[]) => {
    const route: Route = routeFor(routes, method, args);

    if (route === 'unsupported') {
      throw new UnsupportedOperationError(
        `${method}() is not supported. Change streams need a resume story that belongs ` +
          'with the watcher, so they are out of scope in this version.'
      );
    }

    // Rejected rather than thrown: every other routed call returns a promise,
    // and a caller awaiting this one should not also need a try/catch.
    if (route === 'read' && hasSession(args)) {
      return Promise.reject(
        new SessionRoutingError(
          `${method}() was given a session but routes to the read client, and the driver ` +
            'requires a session to come from the same MongoClient. Sessions and transactions ' +
            'must stay on the primary.'
        )
      );
    }

    const client = () => (route === 'read' ? router.read() : router.write());

    if (CURSOR_METHODS.has(method)) {
      return createCursorProxy(() => invoke(client(), owner, method, args), method);
    }

    if (BULK_METHODS.has(method)) {
      return createBulkProxy(() => invoke(client(), owner, method, args), method);
    }

    return invoke(client(), owner, method, args);
  };
}

async function invoke(
  client: Promise<MongoClient>,
  owner: Owner,
  method: string,
  args: unknown[]
) {
  const target = owner(await client);

  return callMethod(target, method, args, `The mongodb driver has no ${method}() to delegate to.`);
}

function hasSession(args: unknown[]): boolean {
  return args.some(hasSessionArgument);
}

function hasSessionArgument(arg: unknown): arg is { session: unknown } {
  return typeof arg === 'object' && arg !== null && 'session' in arg && arg.session != null;
}
