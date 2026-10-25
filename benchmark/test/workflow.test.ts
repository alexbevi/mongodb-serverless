import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('measures once and derives the gate, charts and summary from that one run', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = workflow.split(/^  (?=[\w-]+:\s*$)/m).slice(1);
  const benchmark = jobs.find(job => job.startsWith('benchmark:'));

  expect(benchmark, 'dedicated benchmark job').toBeDefined();

  for (const name of ['test:', 'benchmark:', 'plugin-aws-ssm:']) {
    expect(jobs.find(job => job.startsWith(name)), 'MongoDB 8 needs a compatible runner kernel').toContain('runs-on: ubuntu-22.04');
  }

  expect(jobs.filter(job => job.includes('pnpm benchmark '))).toEqual([benchmark]);
  expect(benchmark!.match(/pnpm benchmark /g)).toHaveLength(1);
  expect(benchmark).toContain('pnpm benchmark --samples 40 --output "$RUNNER_TEMP/benchmark/samples.json"');
  expect(workflow).not.toContain('--diagnostics');
  expect(benchmark).not.toMatch(/\b(?:needs|strategy|matrix):/);
  expect(benchmark).toMatch(/node-version: ['"]?24['"]?\s/);
  expect(benchmark).toContain('python3 benchmark/report.py "$RUNNER_TEMP/benchmark/samples.json"');
  // hashFiles() only sees the workspace, so it cannot gate on files under runner.temp.
  const render = benchmark!.split(/^      - /m).find(step => step.includes('benchmark/report.py'));
  expect(render).toContain("if: always() && steps.measure.outcome == 'success'");
  expect(benchmark).not.toContain('hashFiles(');
  expect(benchmark).toContain('python3 benchmark/performance.py "$RUNNER_TEMP/benchmark/samples.json"');
  expect(benchmark).toContain('BENCHMARK_RESULT: ${{ runner.temp }}/benchmark/samples.json');
  expect(benchmark).toContain('python3 benchmark/ci_summary.py');
  expect(benchmark).toContain('name: benchmark-node-24');
  expect(benchmark).toContain('path: ${{ runner.temp }}/benchmark/');
  expect(workflow).toContain("node: ['20.19', '24']");
});

it('uploads each case chart on its own so the summary can link it', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/^      - /m);
  const summary = steps.find(step => step.includes('name: Summarize benchmark'));

  for (const chart of ['read-native', 'read-no-plugin', 'read-ssm', 'read-ssm-uncached', 'write-native',
    'write-no-plugin-1-connection', 'write-no-plugin-2-connections', 'write-ssm', 'write-ssm-uncached']) {
    const upload = steps.find(step => step.includes(`id: chart-${chart}\n`));

    expect(upload, chart).toContain(`path: \${{ runner.temp }}/benchmark/${chart}.png`);
    expect(upload, chart).toContain('archive: false');
    expect(summary, chart).toContain(`"${chart}": "\${{ steps.chart-${chart}.outputs.artifact-url }}"`);
  }
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
