"""Write the benchmark result to the GitHub Actions job summary."""
import json
import os
from pathlib import Path

from performance import check_performance


def render_summary(data, node_version, outcome, image_url, result_url):
    lines = [f'## Cold-operation benchmark · Node {node_version}', '']
    try:
        if data is None:
            raise ValueError('No result JSON was produced; see the benchmark step log.')
        results = check_performance(data)
        passed = outcome == 'success' and all(row['passed'] for row in results)
        lines.extend([
            '**✅ Benchmark passed**' if passed else '**❌ Benchmark failed**', '',
            '100 iterations per operation and client · median latency · required reduction **≥10%** for both operations.', '',
            '| Operation | MongoDB | Serverless | Reduction | Gate |',
            '| :--- | ---: | ---: | ---: | :---: |',
        ])
        for row in results:
            lines.append(f"| {row['operation'].title()} | {row['nativeMedianMs']:.2f} ms | "
                         f"{row['serverlessMedianMs']:.2f} ms | **{row['improvementPercent']:.2f}%** | "
                         f"{'✅' if row['passed'] else '❌'} |")
    except (ValueError, KeyError, TypeError) as error:
        lines.extend(['**⚠️ Benchmark incomplete**', '', f'Invalid benchmark result: {error}'])
    lines.append('')
    if image_url:
        lines.extend([f'![Latency diagram]({image_url})', ''])
    if result_url:
        lines.extend([f'[Download result JSON]({result_url})', ''])
    if image_url or result_url:
        lines.append('Artifacts expire after 7 days; viewing them requires signing in to GitHub.')
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    source = Path(os.environ['BENCHMARK_RESULT'])
    data = json.loads(source.read_text()) if source.exists() else None
    summary = render_summary(data, os.environ['BENCHMARK_NODE'], os.environ['BENCHMARK_OUTCOME'],
                             os.environ.get('BENCHMARK_IMAGE_URL', ''), os.environ.get('BENCHMARK_RESULT_URL', ''))
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as output:
        output.write(summary)
