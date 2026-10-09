import { InvalidPluginError, MissingPluginError, PluginNotInstalledError } from './errors.js';
import type { TopologyPlugin } from './plugin.js';

/** A plugin, or the name of a package exporting one. */
export type PluginSource = TopologyPlugin | string;

const REQUIRED_METHODS = ['setup', 'verify', 'read', 'write'] as const;

const REQUIRED_DETAILS = ['name', 'version', 'author'] as const;

interface PluginFields {
  setup?: unknown;
  verify?: unknown;
  read?: unknown;
  write?: unknown;
  name?: unknown;
  version?: unknown;
  author?: unknown;
}

interface ModuleExports {
  default?: unknown;
  plugin?: unknown;
  Plugin?: unknown;
}

interface ResolutionError {
  code?: unknown;
  message?: unknown;
}

let defaultPlugin: PluginSource | undefined;

/** Sets the plugin used by clients that pass none. */
export function setDefaultPlugin(source: PluginSource): void {
  defaultPlugin = source;
}

export function clearDefaultPlugin(): void {
  defaultPlugin = undefined;
}

/** Resolves a plugin from an explicit source, else the configured default. */
export async function resolvePlugin(source?: PluginSource): Promise<TopologyPlugin> {
  const chosen = source ?? defaultPlugin;

  if (chosen == null) {
    throw new MissingPluginError(
      'No plugin configured. Pass one as new MongoClient(uri, { plugin }), ' +
        'or call setDefaultPlugin() once at startup.'
    );
  }

  if (!isSpecifier(chosen)) {
    validatePlugin(chosen, 'the supplied plugin');

    return chosen;
  }

  return load(chosen);
}

async function load(specifier: string): Promise<TopologyPlugin> {
  let module: ModuleExports;

  try {
    module = await import(/* @vite-ignore */ specifier);
  } catch (cause) {
    // Only blame the requested package, not a missing dependency inside it.
    if (isResolutionFailure(cause) && namesPackage(cause, specifier)) {
      throw new PluginNotInstalledError(
        `Cannot resolve plugin "${specifier}". Install it with: npm install ${specifier}`,
        { cause }
      );
    }

    throw cause;
  }

  const preferred = [module.default, module.plugin, module.Plugin];

  const named = Object.entries(module).flatMap(([name, value]) =>
    ['default', 'plugin', 'Plugin'].includes(name) ? [] : [value]
  );

  for (const candidate of [...preferred, ...named, module]) {
    let value: unknown = candidate;

    if (isFunction(candidate)) {
      // Inspect the prototype before constructing an unrelated named export.
      if (!buildsAPlugin(candidate)) continue;

      try {
        value = Reflect.construct(candidate, []);
      } catch (cause) {
        throw constructionError(cause, specifier);
      }
    }

    if (hasPluginMethods(value)) {
      validatePlugin(value, specifier);

      return value;
    }
  }

  const fallback = module.default ?? module.plugin ?? module;

  if (isFunction(fallback)) return construct(fallback, specifier);

  validatePlugin(fallback, specifier);

  return fallback;
}

function construct(candidate: Function, specifier: string): TopologyPlugin {
  let value: unknown;

  try {
    value = Reflect.construct(candidate, []);
  } catch (cause) {
    throw constructionError(cause, specifier);
  }

  validatePlugin(value, specifier);

  return value;
}

function constructionError(cause: unknown, specifier: string): InvalidPluginError {
  return new InvalidPluginError(
    `Plugin "${specifier}" exports a function that could not be constructed with no arguments.`,
    { cause }
  );
}

/** Checks methods structurally because duplicate package copies break instanceof. */
export function validatePlugin(value: unknown, source: string): asserts value is TopologyPlugin {
  if (!isPluginFields(value)) {
    throw new InvalidPluginError(
      `Plugin from ${source} is ${value === null ? 'null' : typeof value}, not an object.`
    );
  }

  const missing = [
    ...REQUIRED_METHODS.filter(method => !isFunction(value[method])),
    ...REQUIRED_DETAILS.filter(detail => !isString(value[detail]))
  ];

  if (missing.length > 0) {
    throw new InvalidPluginError(
      `Plugin from ${source} is missing: ${missing.join(', ')}. ` +
        `A plugin needs methods ${REQUIRED_METHODS.join('/')} and string ${REQUIRED_DETAILS.join('/')}.`
    );
  }
}

function hasPluginMethods(value: unknown): value is Pick<TopologyPlugin, typeof REQUIRED_METHODS[number]> {
  return isPluginFields(value) && REQUIRED_METHODS.every(method => isFunction(value[method]));
}

function buildsAPlugin(candidate: Function): boolean {
  const prototype: unknown = candidate.prototype;

  return hasPluginMethods(prototype);
}

/** Node, bundlers, and test runners use different resolution error formats. */
function isResolutionFailure(error: unknown): error is ResolutionError {
  if (typeof error !== 'object' || error === null) return false;

  if ('code' in error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
    return true;
  }

  return 'message' in error && isString(error.message) &&
    /cannot find (?:package|module)|failed to (?:load|resolve)/i.test(error.message);
}

/** True when the error blames this specifier rather than one of its imports. */
function namesPackage(error: ResolutionError, specifier: string): boolean {
  const message = isString(error.message) ? error.message : '';
  const quoted = [`'${specifier}'`, `"${specifier}"`].some(form => message.includes(form));

  // Bundlers can report the specifier without quotes.
  return quoted || new RegExp(`(?:^|\\s)${escapeRegExp(specifier)}(?:\\s|$|\\.|,|\\))`).test(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPluginFields(value: unknown): value is PluginFields {
  return typeof value === 'object' && value !== null;
}

function isFunction(value: unknown): value is Function {
  return typeof value === 'function';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isSpecifier(value: PluginSource): value is string {
  return typeof value === 'string';
}
