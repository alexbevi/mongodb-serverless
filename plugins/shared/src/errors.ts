/**
 * Base for every error this project raises.
 *
 * The contract compiles into each package, so the driver and a plugin hold
 * separate copies of these classes and `instanceof` across that boundary is
 * false. Match on `name` instead, which is stable across copies.
 */
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
