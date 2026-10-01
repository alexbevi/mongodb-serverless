import { ServerlessError } from '../../plugins/shared/src/index.js';

/**
 * Base for every error the watcher raises.
 *
 * Match on `name` rather than `instanceof` when catching across a package
 * boundary; see the note on {@link ServerlessError}.
 */
export class WatcherError extends ServerlessError {}

/** The cluster could not be reached: refused connection, bad host, timeout. */
export class ClusterUnreachableError extends WatcherError {}

/** The credentials in the connection string were rejected. */
export class AuthenticationFailedError extends WatcherError {}

/** The cluster is reachable but is not a replica set. */
export class NotAReplicaSetError extends WatcherError {}

export { PluginReadOnlyError, MissingPluginError } from '../../plugins/shared/src/index.js';
