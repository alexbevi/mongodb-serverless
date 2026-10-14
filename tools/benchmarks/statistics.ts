export function summarize(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle];
  const low = sorted[middle - 1];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];

  if (high === undefined || p95 === undefined) throw new RangeError('No benchmark samples');

  return { median: sorted.length % 2 === 0 && low !== undefined ? (low + high) / 2 : high, p95 };
}
