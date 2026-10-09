import { describe, expect, it } from 'vitest';
import { Collection, Db } from 'mongodb';
import {
  COLLECTION_ROUTES,
  DB_ROUTES,
  routeFor,
  type Route
} from '../src/routing.js';

function isMethodDescriptor(
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor & { value: Function } {
  return typeof descriptor?.value === 'function';
}

const publicMethods = (prototype: Collection | Db): string[] =>
  Object.getOwnPropertyNames(prototype)
    .filter(name => name !== 'constructor' && !name.startsWith('_'))
    .filter(name => isMethodDescriptor(Object.getOwnPropertyDescriptor(prototype, name)))
    .sort();

const route = (method: string, args: unknown[] = []): Route =>
  routeFor(COLLECTION_ROUTES, method, args);

describe('routeFor', () => {
  it.each(['find', 'findOne', 'distinct', 'countDocuments', 'listIndexes', 'indexes'])(
    'routes %s to the read client',
    method => {
      expect(route(method)).toBe('read');
    }
  );

  it.each(['insertOne', 'updateMany', 'deleteOne', 'findOneAndUpdate', 'bulkWrite', 'drop'])(
    'routes %s to the write client',
    method => {
      expect(route(method)).toBe('write');
    }
  );

  it('routes search index mutations to the write client', () => {
    // These declare no Aspect in the driver, so an aspect-derived table would
    // misroute them as reads.
    for (const method of [
      'createSearchIndex',
      'createSearchIndexes',
      'dropSearchIndex',
      'updateSearchIndex'
    ]) {
      expect(route(method), method).toBe('write');
    }
  });

  it('routes listSearchIndexes to the read client', () => {
    expect(route('listSearchIndexes')).toBe('read');
  });

  it('routes rename to the write client', () => {
    expect(route('rename', ['other'])).toBe('write');
  });

  it('routes both bulk op builders to the write client', () => {
    expect(route('initializeOrderedBulkOp')).toBe('write');
    expect(route('initializeUnorderedBulkOp')).toBe('write');
  });

  it('marks watch unsupported', () => {
    expect(route('watch')).toBe('unsupported');
  });

  describe('aggregate', () => {
    it('is a read with no write stage', () => {
      expect(route('aggregate', [[{ $match: { a: 1 } }]])).toBe('read');
    });

    it('is a read with no pipeline at all', () => {
      expect(route('aggregate', [])).toBe('read');
    });

    it('is a write when the last stage is $out', () => {
      expect(route('aggregate', [[{ $match: {} }, { $out: 'dest' }]])).toBe('write');
    });

    it('is a write when the last stage is $merge', () => {
      expect(route('aggregate', [[{ $match: {} }, { $merge: { into: 'dest' } }]])).toBe('write');
    });

    it('is a read when $out is not the last stage', () => {
      // Mirrors the driver, which only inspects the final stage.
      expect(route('aggregate', [[{ $out: 'dest' }, { $match: {} }]])).toBe('read');
    });

    it('is a write when options.out is set', () => {
      expect(route('aggregate', [[{ $match: {} }], { out: 'dest' }])).toBe('write');
    });

    it('ignores a non-array pipeline', () => {
      expect(route('aggregate', [undefined])).toBe('read');
    });
  });

  describe('explicit readPreference', () => {
    it('sends a read to the write client when primary is requested', () => {
      expect(route('find', [{}, { readPreference: 'primary' }])).toBe('write');
    });

    it('accepts a ReadPreference-shaped object', () => {
      expect(route('find', [{}, { readPreference: { mode: 'primary' } }])).toBe('write');
    });

    it('keeps a read on the read client for secondary', () => {
      expect(route('find', [{}, { readPreference: 'secondary' }])).toBe('read');
    });

    it('keeps a read on the read client for secondaryPreferred', () => {
      expect(route('find', [{}, { readPreference: 'secondaryPreferred' }])).toBe('read');
    });

    it('sends a read to the write client for primaryPreferred', () => {
      expect(route('find', [{}, { readPreference: 'primaryPreferred' }])).toBe('write');
    });

    it('does not move a write to the read client', () => {
      expect(route('insertOne', [{}, { readPreference: 'secondary' }])).toBe('write');
    });

    it('does not override an unsupported method', () => {
      expect(route('watch', [[], { readPreference: 'secondary' }])).toBe('unsupported');
    });
  });

  it('throws on an unclassified method', () => {
    expect(() => route('somethingNew')).toThrow(/somethingNew/);
  });
});

describe('route coverage', () => {
  it('classifies every public Collection method', () => {
    const unclassified = publicMethods(Collection.prototype).filter(m => !(m in COLLECTION_ROUTES));

    expect(unclassified).toEqual([]);
  });

  it('classifies every public Db method', () => {
    const unclassified = publicMethods(Db.prototype).filter(m => !(m in DB_ROUTES));

    expect(unclassified).toEqual([]);
  });

  it('classifies no method the driver does not have', () => {
    const real = new Set(publicMethods(Collection.prototype));
    const stale = Object.keys(COLLECTION_ROUTES).filter(m => !real.has(m));

    expect(stale).toEqual([]);
  });
});

describe('DB_ROUTES', () => {
  it('routes reads and writes', () => {
    expect(routeFor(DB_ROUTES, 'listCollections', [])).toBe('read');
    expect(routeFor(DB_ROUTES, 'createCollection', ['c'])).toBe('write');
    expect(routeFor(DB_ROUTES, 'dropDatabase', [])).toBe('write');
  });

  it('routes an arbitrary command to the write client', () => {
    // A command may mutate, and the driver cannot tell from the name.
    expect(routeFor(DB_ROUTES, 'command', [{ ping: 1 }])).toBe('write');
    expect(routeFor(DB_ROUTES, 'runCursorCommand', [{ find: 'c' }])).toBe('write');
  });

  it('applies the aggregate pipeline rule', () => {
    expect(routeFor(DB_ROUTES, 'aggregate', [[{ $merge: { into: 'd' } }]])).toBe('write');
    expect(routeFor(DB_ROUTES, 'aggregate', [[{ $match: {} }]])).toBe('read');
  });
});
