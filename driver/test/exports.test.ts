import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as wrapper from '../src/index.js';

const require = createRequire(import.meta.url);
const mongodb = require('mongodb') as Record<string, unknown>;
const { version } = require('mongodb/package.json') as { version: string };

/** The version the generated re-exports were built against. */
const PINNED = '7.7.0';

describe('export surface', () => {
  it('is pinned to the mongodb version it was generated against', () => {
    // On a driver upgrade, re-run scripts/generate-reexports.mjs and bump this,
    // then re-verify the findings listed in AGENTS.md.
    expect(version).toBe(PINNED);
  });

  it('re-exports every public mongodb name', () => {
    // Nine names are exported at runtime but marked "Excluded from this
    // release type" in mongodb.d.ts, so re-exporting them would not typecheck.
    const internal = new Set(wrapper.INTERNAL_MONGODB_EXPORTS);
    const missing = Object.keys(mongodb).filter(
      name => !internal.has(name) && !(name in wrapper)
    );

    expect(missing).toEqual([]);
  });

  it('omits only names the driver marks internal', () => {
    const omitted = Object.keys(mongodb).filter(name => !(name in wrapper));

    expect(omitted.sort()).toEqual([...wrapper.INTERNAL_MONGODB_EXPORTS].sort());
  });

  it('overrides MongoClient', () => {
    expect(wrapper.MongoClient).not.toBe(mongodb['MongoClient']);
  });

  it('passes other classes through unchanged', () => {
    expect(wrapper.ObjectId).toBe(mongodb['ObjectId']);
    expect(wrapper.Db).toBe(mongodb['Db']);
    expect(wrapper.Collection).toBe(mongodb['Collection']);
    expect(wrapper.ReadPreference).toBe(mongodb['ReadPreference']);
  });

  it('passes error classes through unchanged', () => {
    expect(wrapper.MongoServerError).toBe(mongodb['MongoServerError']);
    expect(wrapper.MongoNetworkError).toBe(mongodb['MongoNetworkError']);
  });

  it('exports the plugin helpers', () => {
    expect(wrapper.setDefaultPlugin).toBeTypeOf('function');
    expect(wrapper.clearDefaultPlugin).toBeTypeOf('function');
  });

  it('exports its own error classes', () => {
    for (const name of [
      'ServerlessDriverError',
      'MissingPluginError',
      'InvalidPluginError',
      'PluginNotInstalledError',
      'NoTopologyError',
      'InvalidTopologyError',
      'NoPrimaryError',
      'SessionRoutingError',
      'UnsupportedOperationError'
    ]) {
      expect(wrapper, name).toHaveProperty(name);
    }
  });

  it('constructs a MongoClient without connecting', () => {
    const client = new wrapper.MongoClient('mongodb://host:27017/', {
      plugin: {
        name: 'stub',
        version: '1.0.0',
        author: 'test',
        setup: async () => {},
        verify: async () => {},
        read: async () => ({ set: 'rs0', members: [] }),
        write: async () => {}
      }
    });

    expect(client).toBeInstanceOf(wrapper.MongoClient);
  });
});
