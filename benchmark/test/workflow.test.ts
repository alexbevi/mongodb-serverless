import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('runs the performance gate once on an independent Node 24 runner', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = workflow.split(/^  (?=[\w-]+:\s*$)/m).slice(1);
  const benchmark = jobs.find(job => job.startsWith('benchmark:'));

  expect(benchmark, 'dedicated benchmark job').toBeDefined();
  expect(jobs.filter(job => job.includes('pnpm benchmark --'))).toEqual([benchmark]);
  expect(benchmark).not.toMatch(/\b(?:needs|strategy|matrix):/);
  expect(benchmark).not.toContain('matrix.node');
  expect(benchmark).toMatch(/node-version: ['"]?24['"]?\s/);
  expect(benchmark).toContain('pnpm install --frozen-lockfile');
  expect(benchmark).toContain('pnpm benchmark --no-monitoring --samples 100');
  expect(benchmark).toContain('python3 benchmark/performance.py');
  expect(benchmark).toContain('python3 benchmark/ci_summary.py');
  expect(benchmark).toContain('name: benchmark-node-24');
  expect(benchmark).toContain('latency-node-24.png');
  expect(benchmark).not.toContain('pnpm test');
  expect(workflow).toContain("node: ['20.19', '24']");
});
