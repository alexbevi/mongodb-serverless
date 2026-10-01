import { describe, expect, it } from 'vitest';
import { PluginReadOnlyError, ServerlessError } from '../src/index.js';

/**
 * Compiling the contract into each package means every package gets its own
 * copy of these classes, so `instanceof` across a package boundary is false.
 * The same reason the driver validates plugins structurally.
 *
 * Catching by `name` works across copies, so the classes have to carry a
 * stable one.
 */
describe('error identity across duplicate copies', () => {
  it('reports a stable name', () => {
    expect(new PluginReadOnlyError('x').name).toBe('PluginReadOnlyError');
  });

  it('keeps the name on a separately declared copy of the class', () => {
    // Stands in for the driver's copy and the plugin's copy.
    class PluginReadOnlyErrorCopy extends ServerlessError {}
    Object.defineProperty(PluginReadOnlyErrorCopy, 'name', {
      value: 'PluginReadOnlyError'
    });

    expect(new PluginReadOnlyErrorCopy('x').name).toBe('PluginReadOnlyError');
  });

  it('is an Error whichever copy threw it', () => {
    expect(new PluginReadOnlyError('x')).toBeInstanceOf(Error);
  });

  it('carries the message', () => {
    expect(new PluginReadOnlyError('read-only').message).toBe('read-only');
  });
});
