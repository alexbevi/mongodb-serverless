import type { Collection, Db, MongoClient } from 'mongodb';
import {
  ServerlessDriverError,
  SessionRoutingError,
  UnsupportedOperationError
} from './errors.js';
import { COLLECTION_ROUTES, DB_ROUTES, routeFor, type Route } from './routing.js';

/** Hands back the client an operation should run on. */
export interface Router {
  read(): Promise<MongoClient>;
  write(): Promise<MongoClient>;
}

type Routes = Record<string, Route | 'pipeline'>;

/** Resolves the real object a call delegates to, once its client is known. */
type Owner = (client: MongoClient) => unknown;

export function createDbFacade(router: Router, dbName: string): Db {
  const local: Record<string, unknown> = { databaseName: dbName, namespace: dbName };
  const owner: Owner = client => client.db(dbName);

  return new Proxy({} as Db, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (property in local) return local[property];

      if (property === 'collection') {
        return (name: string) => createCollectionFacade(router, dbName, name);
      }

      return routedMethod(router, DB_ROUTES, property, owner);
    },

    has(_target, property) {
      return typeof property === 'string' && (property in local || property in DB_ROUTES);
    }
  });
}

export function createCollectionFacade(router: Router, dbName: string, name: string): Collection {
  const local: Record<string, unknown> = {
    collectionName: name,
    dbName,
    namespace: `${dbName}.${name}`
  };
  const owner: Owner = client => client.db(dbName).collection(name);

  return new Proxy({} as Collection, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (property in local) return local[property];

      return routedMethod(router, COLLECTION_ROUTES, property, owner);
    },

    has(_target, property) {
      return typeof property === 'string' && (property in local || property in COLLECTION_ROUTES);
    }
  });
}

/**
 * Stands in for one method on the real object.
 *
 * Routing needs the topology, which means awaiting it, so every routed call
 * returns a promise. Methods that hand back a cursor or a bulk builder
 * synchronously cannot work this way; they are classified but not yet
 * delegated.
 */
function routedMethod(router: Router, routes: Routes, method: string, owner: Owner): unknown {
  if (!(method in routes)) {
    throw new ServerlessDriverError(
      `"${method}" is not a routable operation on this proxy. ` +
        'If the mongodb driver added it, it needs a routing rule; see AGENTS.md.'
    );
  }

  return (...args: unknown[]) => {
    const route = routeFor(routes, method, args);

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

    return invoke(route === 'read' ? router.read() : router.write(), owner, method, args);
  };
}

async function invoke(
  client: Promise<MongoClient>,
  owner: Owner,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const target = owner(await client) as Record<string, unknown>;
  const fn = target[method];

  if (typeof fn !== 'function') {
    throw new ServerlessDriverError(`The mongodb driver has no ${method}() to delegate to.`);
  }

  return (fn as (...a: unknown[]) => unknown).apply(target, args);
}

function hasSession(args: unknown[]): boolean {
  return args.some(
    arg =>
      typeof arg === 'object' &&
      arg !== null &&
      'session' in arg &&
      (arg as { session?: unknown }).session != null
  );
}
