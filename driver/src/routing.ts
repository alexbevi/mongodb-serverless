import { ServerlessDriverError } from './errors.js';

export type Route = 'read' | 'write' | 'unsupported';

/**
 * Where each method goes, and how its arguments can change that.
 *
 * `pipeline` marks a method that is a read until its last stage writes, which
 * is how the driver itself decides. Classification is by hand rather than from
 * the driver's `Aspect` metadata because the search index operations declare no
 * aspect at all and would come out as reads.
 */
type Rule = Route | 'pipeline';

export const COLLECTION_ROUTES = {
  aggregate: 'pipeline',
  bulkWrite: 'write',
  count: 'read',
  countDocuments: 'read',
  createIndex: 'write',
  createIndexes: 'write',
  createSearchIndex: 'write',
  createSearchIndexes: 'write',
  deleteMany: 'write',
  deleteOne: 'write',
  distinct: 'read',
  drop: 'write',
  dropIndex: 'write',
  dropIndexes: 'write',
  dropSearchIndex: 'write',
  estimatedDocumentCount: 'read',
  find: 'read',
  findOne: 'read',
  findOneAndDelete: 'write',
  findOneAndReplace: 'write',
  findOneAndUpdate: 'write',
  indexes: 'read',
  indexExists: 'read',
  indexInformation: 'read',
  initializeOrderedBulkOp: 'write',
  initializeUnorderedBulkOp: 'write',
  insertMany: 'write',
  insertOne: 'write',
  isCapped: 'read',
  listIndexes: 'read',
  listSearchIndexes: 'read',
  options: 'read',
  rename: 'write',
  replaceOne: 'write',
  updateMany: 'write',
  updateOne: 'write',
  updateSearchIndex: 'write',
  watch: 'unsupported'
} satisfies Record<string, Rule>;

export const DB_ROUTES = {
  admin: 'write',
  aggregate: 'pipeline',
  collection: 'read',
  collections: 'read',
  // An arbitrary command may mutate, and the name does not say.
  command: 'write',
  createCollection: 'write',
  createIndex: 'write',
  dropCollection: 'write',
  dropDatabase: 'write',
  indexInformation: 'read',
  listCollections: 'read',
  profilingLevel: 'read',
  removeUser: 'write',
  renameCollection: 'write',
  runCursorCommand: 'write',
  setProfilingLevel: 'write',
  stats: 'read',
  watch: 'unsupported'
} satisfies Record<string, Rule>;

/** Read preference modes that still require the primary. */
const PRIMARY_MODES = new Set(['primary', 'primaryPreferred']);

/** Decides where a call goes, given its method name and arguments. */
export function routeFor(routes: Record<string, Rule>, method: string, args: unknown[]): Route {
  const rule = routes[method];

  if (rule == null) {
    throw new ServerlessDriverError(
      `Operation "${method}" is not classified as a read or a write, so it cannot be routed. ` +
        'This usually means the mongodb driver added a method; see AGENTS.md.'
    );
  }

  if (rule === 'unsupported') return 'unsupported';

  const route = rule === 'pipeline' ? pipelineRoute(args) : rule;

  // An explicit read preference can pull a read onto the primary, but never
  // pushes a write off it.
  if (route === 'read' && wantsPrimary(args)) return 'write';

  return route;
}

/**
 * Matches the driver: only the final stage counts, plus the `out` option
 * shortcut.
 */
function pipelineRoute(args: unknown[]): Route {
  const pipeline = args[0];

  if (isRoutingFields(args[1]) && args[1].out != null) return 'write';

  if (!Array.isArray(pipeline) || pipeline.length === 0) return 'read';

  const last = pipeline.at(-1);

  if (isRoutingFields(last) && (last['$out'] != null || last['$merge'] != null)) return 'write';

  return 'read';
}

function wantsPrimary(args: unknown[]): boolean {
  for (const arg of args) {
    if (!isRoutingFields(arg)) continue;

    const preference = arg['readPreference'];

    if (isReadPreferenceString(preference)) return PRIMARY_MODES.has(preference);

    if (isReadPreferenceObject(preference)) {
      return PRIMARY_MODES.has(preference['mode']);
    }
  }

  return false;
}

interface RoutingFields {
  out?: unknown;
  $out?: unknown;
  $merge?: unknown;
  readPreference?: unknown;
}

function isRoutingFields(value: unknown): value is RoutingFields {
  return typeof value === 'object' && value !== null;
}

function isReadPreferenceString(value: unknown): value is string {
  return typeof value === 'string';
}

function isReadPreferenceObject(value: unknown): value is { mode: string } {
  return typeof value === 'object' && value !== null && 'mode' in value && typeof value.mode === 'string';
}
