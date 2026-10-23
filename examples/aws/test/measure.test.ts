import { expect, it } from 'vitest';
import { summarize, table } from '../measure.js';

it('summarizes server timing without including caller latency', () => {
  const summary = summarize([
    { connectMs: 10, operationMs: 2 },
    { connectMs: 20, operationMs: 4 },
    { connectMs: 30, operationMs: 6 }
  ]);

  expect(summary).toEqual({
    samples: 3,
    connectMeanMs: 20,
    operationMeanMs: 4,
    totalMeanMs: 24,
    totalMedianMs: 24,
    totalStandardDeviationMs: 9.798,
    totalP95Ms: 36
  });
});

it('renders cold and warm results with package size', () => {
  const output = table([{
    variant: 'native', operation: 'find', temperature: 'cold', packageBytes: 2048,
    summary: {
      samples: 3, connectMeanMs: 20, operationMeanMs: 4, totalMeanMs: 24,
      totalMedianMs: 24, totalStandardDeviationMs: 9.798, totalP95Ms: 36
    }
  }]);

  expect(output).toContain('| native | find | cold | 20.0 | 4.0 | 24.0 | 9.8 | 36.0 | 2.0 | 3 |');
});
