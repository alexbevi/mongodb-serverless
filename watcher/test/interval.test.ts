import { expect, it } from 'vitest';
import { refreshIntervalMS } from '../src/interval.js';

it('reads an optional config getter with its receiver and defaults for invalid values', () => {
  const plugin = {
    name: 'test', version: '1', author: 'test',
    async setup() {}, async verify() {},
    async read() { return { members: [] }; }, async write() {},
    interval: 250,
    get(key: string) {
      expect(key).toBe('refreshIntervalMS');

      return this.interval;
    }
  };

  expect(refreshIntervalMS(plugin)).toBe(250);

  const invalid = [
    { ...plugin, get: undefined },
    { ...plugin, get: () => '250' },
    { ...plugin, interval: -1 }
  ];

  for (const candidate of invalid) expect(refreshIntervalMS(candidate)).toBe(10_000);
});
