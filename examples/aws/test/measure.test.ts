import { expect, it } from 'vitest';
import { summarize, table } from '../measure.js';

it('summarizes server timing without including caller latency', () => {
  const summary = summarize([
    { ssmMs: 5, connectMs: 10, operationMs: 2 },
    { ssmMs: 5, connectMs: 20, operationMs: 4 },
    { ssmMs: 5, connectMs: 30, operationMs: 6 }
  ]);

  expect(summary).toEqual({
    samples: 3,
    ssmMeanMs: 5,
    connectMeanMs: 20,
    operationMeanMs: 4,
    totalMeanMs: 29,
    totalMedianMs: 29,
    totalStandardDeviationMs: 9.798,
    totalP95Ms: 41
  });
});

it('renders cold and warm results with package size', () => {
  const output = table([{
    variant: 'native', operation: 'find', temperature: 'cold', packageBytes: 2048,
    summary: {
      samples: 3, ssmMeanMs: 5, connectMeanMs: 20, operationMeanMs: 4, totalMeanMs: 29,
      totalMedianMs: 29, totalStandardDeviationMs: 9.798, totalP95Ms: 41
    }
  }]);

  expect(output).toContain('| native | find | cold | 5.0 | 20.0 | 4.0 | 29.0 | 9.8 | 41.0 | 2.0 | 3 |');
});
