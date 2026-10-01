import { ServerlessError } from '../../plugins/shared/src/index.js';

/** Base for every error the driver raises, so callers can catch one type. */
export class ServerlessDriverError extends ServerlessError {}

/** The plugin returned nothing. */
export class NoTopologyError extends ServerlessDriverError {}

/** The topology document is present but unusable. */
export class InvalidTopologyError extends ServerlessDriverError {}

/** No member reports PRIMARY, so writes have nowhere to go. */
export class NoPrimaryError extends ServerlessDriverError {}

/**
 * A session reached an operation that routes to the read client. The driver
 * rejects a session used with a client other than the one that created it.
 */
export class SessionRoutingError extends ServerlessDriverError {}

/** The operation is not supported in this version. */
export class UnsupportedOperationError extends ServerlessDriverError {}

// Raised while resolving a plugin, which the shared contract owns.
export {
  MissingPluginError,
  PluginNotInstalledError,
  InvalidPluginError,
  PluginReadOnlyError,
  ServerlessError
} from '../../plugins/shared/src/index.js';
