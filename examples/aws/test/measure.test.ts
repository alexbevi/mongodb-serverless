import { expect, it } from 'vitest';
import { collectInvocationPair, collectColdTiming, summarize, table } from '../measure.js';

it('retries when AWS routes the request to an old warm environment', async () => {
  let attempts = 0;

  const timing = await collectColdTiming('no-plugin-save', async () => {
    attempts += 1;

    return { coldStart: attempts === 2, ssmMs: 5, connectMs: 20, operationMs: 4 };
  });

  expect(timing.coldStart).toBe(true);
  expect(attempts).toBe(2);
});

it('retries stale environments and retains the following warm timing', async () => {
  const order: string[] = [];
  let attempts = 0;

  const pair = await collectInvocationPair(
    'native-find',
    async () => {
      attempts += 1;
      order.push(`cold-${attempts}`);

      return { coldStart: attempts === 2, ssmMs: 5, connectMs: 20, operationMs: 4 };
    },
    async () => {
      order.push('warm');

      return { coldStart: false, ssmMs: 0, connectMs: 1, operationMs: 2 };
    }
  );

  expect(pair.warm.operationMs).toBe(2);
  expect(order).toEqual(['cold-1', 'cold-2', 'warm']);
});

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
