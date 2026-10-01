/** Base for every error this project raises, so callers can catch one type. */
export class ServerlessError extends Error {
  override get name(): string {
    return this.constructor.name;
  }
}

/** No plugin was supplied by option or setDefaultPlugin. */
export class MissingPluginError extends ServerlessError {}

/** A plugin named by string could not be resolved. */
export class PluginNotInstalledError extends ServerlessError {}

/** The plugin is missing members the contract requires. */
export class InvalidPluginError extends ServerlessError {}

/** A write was attempted through a plugin that was not made writable. */
export class PluginReadOnlyError extends ServerlessError {}
