"""Write the benchmark result to the GitHub Actions job summary."""
import json
import os
from pathlib import Path
from statistics import median

from performance import REQUIRED_REDUCTION, change, check_performance


def local_tls_ms(data):
    handshakes = [s['tls'][1] - s['tls'][0] for sample in data['samples'] for s in sample['trace']['sockets']
                  if s['kind'] == 'application' and 'tls' in s]
    return median(handshakes) if handshakes else None


def note(data, aws_summary):
    local = local_tls_ms(data)
    aws = (aws_summary or {}).get('operations', {}).get('read', {}).get('ssm', {}).get('phaseMeansMs', {}).get('tls')
    cost = (f'a cold TLS handshake costs ~{aws:.0f} ms against ~{local:.0f} ms here' if aws and local
            else 'a cold TLS handshake costs several times more than it does here')
    return (f'\\* Local medians are lower than on AWS Lambda, where {cost}. Native\'s monitor handshakes therefore '
            'cost far less locally, so the serverless reductions are smaller. No-plugin writes that need a second '
            'connection come out about even on AWS but slower locally.')


CHARTS = {
    'read-native': 'Read · native', 'read-no-plugin': 'Read · no plugin', 'read-ssm': 'Read · SSM plugin',
    'read-ssm-uncached': 'Read · SSM plugin, uncached', 'write-native': 'Write · native',
    'write-no-plugin-1-connection': 'Write · no plugin, 1 connection', 'write-no-plugin-2-connections': 'Write · no plugin, 2 connections',
    'write-ssm': 'Write · SSM plugin', 'write-ssm-uncached': 'Write · SSM plugin, uncached',
}


def render_summary(data, node_version, outcome, result_url, aws_summary, chart_urls=None):
    lines = [f'## Cold-operation benchmark · Node {node_version}', '']
    try:
        if data is None:
            raise ValueError('No result JSON was produced; see the benchmark step log.')
        rows = check_performance(data)
        passed = outcome == 'success' and all(row['passed'] for row in rows)
        lines += ['**✅ Benchmark passed**' if passed else '**❌ Benchmark failed**', '',
                  f"{data['configuration']['count']} cold starts per pattern · median latency · the SSM plugin must be "
                  f'**≥{REQUIRED_REDUCTION:.0%} reduced** for both operations.', '',
                  '| Operation | Native | No plugin | SSM plugin | Gate |', '| :--- | ---: | ---: | ---: | :---: |']
        for row in rows:
            native = row['nativeMedianMs']
            lines.append(f"| {row['operation'].title()} | {native:.2f} ms | "
                         f"{row['noPluginMedianMs']:.2f} ms ({change(row['noPluginMedianMs'], native)}) | "
                         f"{row['ssmMedianMs']:.2f} ms ({change(row['ssmMedianMs'], native)}) | {'✅' if row['passed'] else '❌'} |")
        lines += ['', note(data, aws_summary)]
    except (ValueError, KeyError, TypeError) as error:
        lines += ['**⚠️ Benchmark incomplete**', '', f'Invalid benchmark result: {error}']
    charts = [f'[{label}]({chart_urls[slug]})' for slug, label in CHARTS.items() if (chart_urls or {}).get(slug)]
    if charts:
        lines += ['', 'Latency diagrams: ' + ' · '.join(charts)]
    if result_url:
        lines += ['', f'[Download charts and results]({result_url})']
    if charts or result_url:
        lines += ['', 'Artifacts expire after 7 days; downloading them requires signing in to GitHub.']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    source = Path(os.environ['BENCHMARK_RESULT'])
    aws = Path(__file__).with_name('results') / 'aws' / 'summary.json'
    summary = render_summary(json.loads(source.read_text()) if source.exists() else None, os.environ['BENCHMARK_NODE'],
                             os.environ['BENCHMARK_OUTCOME'], os.environ.get('BENCHMARK_RESULT_URL', ''),
                             json.loads(aws.read_text()) if aws.exists() else None,
                             json.loads(os.environ.get('BENCHMARK_CHART_URLS') or '{}'))
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as output:
        output.write(summary)
