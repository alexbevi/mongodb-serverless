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

it('runs the cold Lambda patterns on LocalStack 4.14 and publishes their measurements', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^  (?=[\w-]+:\s*$)/m).find(job => job.startsWith('lambda-patterns:'));

  expect(job, 'dedicated Lambda benchmark job').toBeDefined();
  expect(job).not.toContain('fetch-depth: 0');
  expect(job).not.toContain('origin/main');
  expect(job).toContain('node benchmark/build-lambda.mjs');
  expect(job).toContain('node benchmark/lambda-local.mjs --samples 20');
  expect(job).toContain('python3 benchmark/lambda-report.py');
  expect(job).toContain('lambda-patterns-node-24');
  expect(job).toContain('GITHUB_STEP_SUMMARY');
  const compose = readFileSync(new URL('../docker/lambda-compose.yaml', import.meta.url), 'utf8');
  expect(compose).toContain('localstack/localstack:4.14.0');
});
