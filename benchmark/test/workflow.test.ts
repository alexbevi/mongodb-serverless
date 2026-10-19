import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('runs the performance gate once on an independent Node 24 runner', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = workflow.split(/^  (?=[\w-]+:\s*$)/m).slice(1);
  const benchmark = jobs.find(job => job.startsWith('benchmark:'));

  expect(benchmark, 'dedicated benchmark job').toBeDefined();

  for (const name of ['test:', 'benchmark:']) {
    expect(jobs.find(job => job.startsWith(name)), 'MongoDB 8 needs a compatible runner kernel').toContain('runs-on: ubuntu-22.04');
  }

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

it('renders code-level diagnostics from a separate cohort without instrumenting the performance gate', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/^      - /m);
  const diagnostic = steps.find(step => step.includes('pnpm benchmark --diagnostics'));

  expect(diagnostic, 'separate diagnostic collection step').toBeDefined();
  expect(diagnostic).toContain("if: always() && steps.benchmark.outcome != 'skipped'");
  expect(diagnostic).toContain('pnpm benchmark --diagnostics --no-monitoring --samples 100 --output "$RUNNER_TEMP/benchmark/diagnostics/samples.json"');
  const render = steps.find(step => step.includes('python3 benchmark/report.py'));
  expect(render).toContain('python3 benchmark/report.py "$RUNNER_TEMP/benchmark/diagnostics/samples.json" --environment local');
  expect(render).toContain('mv "$RUNNER_TEMP/benchmark/diagnostics/latency.png" "$RUNNER_TEMP/benchmark/latency-node-$BENCHMARK_NODE.png"');
  expect(steps.find(step => step.includes('id: benchmark-results'))).toContain('${{ runner.temp }}/benchmark/diagnostics/samples.json');
  const gate = steps.find(step => step.includes('id: benchmark\n'));
  expect(gate).not.toContain('--diagnostics');
  expect(gate).toContain('python3 benchmark/performance.py "$RUNNER_TEMP/benchmark/samples.json"');
  expect(steps.find(step => step.includes('name: Summarize benchmark'))).toContain('BENCHMARK_RESULT: ${{ runner.temp }}/benchmark/samples.json');
});

it('checks the AWS SSM plugin against LocalStack alongside the other jobs', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^  (?=[\w-]+:\s*$)/m).find(job => job.startsWith('plugin-aws-ssm:'));

  expect(job, 'dedicated AWS SSM plugin job').toBeDefined();
  expect(job).toContain('name: plugin-aws-ssm');
  expect(job).not.toMatch(/\bneeds:/);
  expect(job).toContain('localstack/localstack:4.14.0');
  expect(job).toContain('SERVICES: ssm,kms');
  expect(job).toContain('SSM_ENDPOINT: http://127.0.0.1:4566');
  expect(job).toContain('pnpm --filter @mongodb-serverless/plugin-aws-ssm test:integration');
  expect(job).not.toContain('benchmark/lambda-');
  expect(workflow).not.toContain('lambda-patterns:');
});
