import { expect, it } from 'vitest';
import { summarize } from '../../../tools/benchmarks/statistics.js';

it('reports the median between the two middle samples for an even sample count', () => {
  expect(summarize([40, 10, 20, 30])).toEqual({ median: 25, p95: 40 });
});
