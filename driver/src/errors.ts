/** Base for every error this wrapper raises, so callers can catch one type. */
export class ServerlessDriverError extends Error {
  override get name(): string {
    return this.constructor.name;
  }
}

/** The plugin returned nothing. */
export class NoTopologyError extends ServerlessDriverError {}

/** The topology document is present but unusable. */
export class InvalidTopologyError extends ServerlessDriverError {}

/** No member reports PRIMARY, so writes have nowhere to go. */
export class NoPrimaryError extends ServerlessDriverError {}

/** No plugin was supplied by option or setDefaultPlugin. */
export class MissingPluginError extends ServerlessDriverError {}

/** A plugin named by string could not be resolved. */
export class PluginNotInstalledError extends ServerlessDriverError {}

/** The plugin is missing members the driver requires. */
export class InvalidPluginError extends ServerlessDriverError {}

/**
 * A session reached an operation that routes to the read client. The driver
 * rejects a session used with a client other than the one that created it.
 */
export class SessionRoutingError extends ServerlessDriverError {}

/** The operation is not supported in this version. */
export class UnsupportedOperationError extends ServerlessDriverError {}
