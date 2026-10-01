import { InvalidPluginError, MissingPluginError, PluginNotInstalledError } from './errors.js';
import type { TopologyPlugin } from './plugin.js';

/** A plugin, or the name of a package exporting one. */
export type PluginSource = TopologyPlugin | string;

const REQUIRED_METHODS = ['setup', 'verify', 'read', 'write'] as const;
const REQUIRED_DETAILS = ['name', 'version', 'author'] as const;

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

  if (typeof chosen !== 'string') {
    validatePlugin(chosen, 'the supplied plugin');
    return chosen;
  }

  return validatePlugin(instantiate(await load(chosen), chosen), chosen);
}

async function load(specifier: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch (cause) {
    // A plugin whose own dependency is missing fails the same way, so the
    // deciding question is which package the error names. Blaming the
    // specifier for someone else's missing dependency would send the user
    // hunting the wrong bug.
    if (isResolutionFailure(cause) && namesPackage(cause, specifier)) {
      throw new PluginNotInstalledError(
        `Cannot resolve plugin "${specifier}". Install it with: npm install ${specifier}`,
        { cause }
      );
    }

    throw cause;
  }
}

/** Accepts a default export, a named `plugin` export, or the module itself. */
function instantiate(module: unknown, specifier: string): unknown {
  const candidates = isRecord(module)
    ? [module['default'], module['plugin'], module['Plugin'], module]
    : [module];

  for (const candidate of candidates) {
    if (candidate == null) continue;

    const value = typeof candidate === 'function' ? construct(candidate, specifier) : candidate;

    if (looksLikePlugin(value)) return value;
  }

  // Nothing matched. Hand back the most likely candidate, constructed if it is
  // a class, so validation names the missing members instead of reporting the
  // export as a function.
  const fallback = isRecord(module) ? (module['default'] ?? module['plugin'] ?? module) : module;

  return typeof fallback === 'function' ? construct(fallback, specifier) : fallback;
}

function construct(candidate: Function, specifier: string): unknown {
  try {
    return new (candidate as new () => unknown)();
  } catch (cause) {
    throw new InvalidPluginError(
      `Plugin "${specifier}" exports a function that could not be constructed with no arguments.`,
      { cause }
    );
  }
}

/**
 * Checks the plugin by shape, never with `instanceof`.
 *
 * `instanceof` returns false across two copies of the same class, which is
 * what a dependency tree holding two versions of plugin-base produces. A valid
 * plugin would be rejected for where it was installed.
 */
export function validatePlugin(value: unknown, source: string): TopologyPlugin {
  if (!isRecord(value)) {
    throw new InvalidPluginError(
      `Plugin from ${source} is ${value === null ? 'null' : typeof value}, not an object.`
    );
  }

  const missing = [
    ...REQUIRED_METHODS.filter(m => typeof (value as Record<string, unknown>)[m] !== 'function'),
    ...REQUIRED_DETAILS.filter(d => typeof (value as Record<string, unknown>)[d] !== 'string')
  ];

  if (missing.length > 0) {
    throw new InvalidPluginError(
      `Plugin from ${source} is missing: ${missing.join(', ')}. ` +
        `A plugin needs methods ${REQUIRED_METHODS.join('/')} and string ${REQUIRED_DETAILS.join('/')}.`
    );
  }

  return value as unknown as TopologyPlugin;
}

function looksLikePlugin(value: unknown): boolean {
  return (
    isRecord(value) &&
    REQUIRED_METHODS.every(m => typeof (value as Record<string, unknown>)[m] === 'function')
  );
}

/**
 * Node reports ERR_MODULE_NOT_FOUND. Bundlers and test runners resolve imports
 * themselves and report their own wording with no code, so match both.
 */
function isResolutionFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;

  if (error['code'] === 'ERR_MODULE_NOT_FOUND' || error['code'] === 'MODULE_NOT_FOUND') return true;

  const message = messageOf(error);

  return /cannot find (?:package|module)|failed to (?:load|resolve)/i.test(message);
}

/** True when the error blames this specifier rather than one of its imports. */
function namesPackage(error: unknown, specifier: string): boolean {
  const message = messageOf(error);
  const quoted = [`'${specifier}'`, `"${specifier}"`].some(form => message.includes(form));

  // Bundlers report the specifier unquoted, e.g. "Failed to load url <spec>".
  return quoted || new RegExp(`(?:^|\\s)${escapeRegExp(specifier)}(?:\\s|$|\\.|,|\\))`).test(message);
}

function messageOf(error: unknown): string {
  return isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Objects and class instances both pass; functions do not. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
