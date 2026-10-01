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

export const COLLECTION_ROUTES: Record<string, Rule> = {
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
};

export const DB_ROUTES: Record<string, Rule> = {
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
};

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
  const [pipeline, options] = args;

  if (isRecord(options) && options['out'] != null) return 'write';

  if (!Array.isArray(pipeline) || pipeline.length === 0) return 'read';

  const last = pipeline.at(-1);

  if (isRecord(last) && (last['$out'] != null || last['$merge'] != null)) return 'write';

  return 'read';
}

function wantsPrimary(args: unknown[]): boolean {
  for (const arg of args) {
    if (!isRecord(arg)) continue;

    const preference = arg['readPreference'];

    if (typeof preference === 'string') return PRIMARY_MODES.has(preference);

    if (isRecord(preference) && typeof preference['mode'] === 'string') {
      return PRIMARY_MODES.has(preference['mode']);
    }
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
