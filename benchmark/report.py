#!/usr/bin/env python3
"""Render the recorded connection samples without rerunning the benchmark."""
import argparse
import json
import math
import os
from collections import defaultdict
from pathlib import Path
from statistics import mean, median

PHASES = {
    'tcp': 'TCP / DNS', 'tls': 'TLS', 'hello': 'Hello + speculative auth',
    'auth': 'Remaining auth', 'send': 'Send / buffer',
    'receive': 'Receive / wait', 'other': 'Other / discovery',
}
VARIANTS = {'native': 'MongoClient', 'serverless': 'ServerlessMongoClient'}


def summarize(samples):
    groups = defaultdict(list)
    for sample in samples:
        groups[(sample['variant'], sample['operation'])].append(sample['timings'])
    result = {}
    for key, timings in groups.items():
        totals = sorted(t['total'] for t in timings)
        result[key] = {
            'count': len(totals), 'mean': mean(totals), 'median': median(totals),
            'p95': totals[math.ceil(len(totals) * .95) - 1],
            'min': min(totals), 'max': max(totals), 'totals': totals,
            'phases': {phase: mean(t[phase] for t in timings) for phase in PHASES},
        }
    return result


def render(data, source, destination):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    summaries = summarize(data['samples'])
    keys = [(variant, operation) for operation in ['read', 'write'] for variant in VARIANTS]
    colors = ['#2563eb', '#38bdf8', '#a78bfa', '#f59e0b', '#ef4444', '#10b981', '#64748b']
    labels = ['MongoClient\nRead', 'Serverless\nRead', 'MongoClient\nWrite', 'Serverless\nWrite']
    fig, (phases_ax, samples_ax) = plt.subplots(1, 2, figsize=(15, 7), gridspec_kw={'width_ratios': [1.15, 1]})
    fig.patch.set_facecolor('#f8fafc')
    for ax in (phases_ax, samples_ax):
        ax.set_facecolor('#f8fafc')
        ax.spines[['top', 'right']].set_visible(False)
        ax.set_ylabel('Milliseconds')
        ax.set_xticks(range(4), labels)
        ax.grid(axis='y', alpha=.18)
        ax.set_axisbelow(True)
        ax.set_ylim(bottom=0)
    bottom = [0.] * 4
    for (phase, label), color in zip(PHASES.items(), colors):
        heights = [summaries[key]['phases'][phase] for key in keys]
        phases_ax.bar(range(4), heights, bottom=bottom, label=label, color=color, width=.65)
        bottom = [a + b for a, b in zip(bottom, heights)]
    for index, total in enumerate(bottom):
        phases_ax.text(index, total + 1, f'{total:.1f}', ha='center', fontweight='bold')
    phases_ax.set_ylim(0, max(bottom) * 1.2)
    phases_ax.set_title('Mean elapsed time by phase', loc='left', fontweight='bold')
    for index, key in enumerate(keys):
        values = summaries[key]['totals']
        xs = [index + ((i * .61803398875) % 1 - .5) * .28 for i in range(len(values))]
        samples_ax.scatter(xs, values, alpha=.4, s=22, color='#2563eb' if key[0] == 'native' else '#0d9488')
        samples_ax.plot([index - .22, index + .22], [summaries[key]['median']] * 2, color='#0f172a', linewidth=2.5)
        samples_ax.annotate(f"p50 {summaries[key]['median']:.1f}", (index, summaries[key]['median']), xytext=(0, 12), textcoords='offset points', ha='center', fontsize=9)
    samples_ax.set_title('Every cold connection sample · line = median', loc='left', fontweight='bold')
    config = data['configuration']
    fig.suptitle('Cold MongoDB connections across three simulated availability zones', fontsize=17, fontweight='bold', x=.06, ha='left')
    fig.text(.06, .91, f"TLS + SCRAM-SHA-256 · primary reads · majority writes · {config['count']} fresh processes per case", fontsize=11, color='#475569')
    fig.legend(*phases_ax.get_legend_handles_labels(), loc='lower center', ncol=4, frameon=False, bbox_to_anchor=(.5, .015))
    fig.subplots_adjust(top=.82, bottom=.24, left=.06, right=.98, wspace=.22)
    asset_dir = source.parent
    asset_dir.mkdir(parents=True, exist_ok=True)
    for extension in ['svg', 'png']:
        fig.savefig(asset_dir / f'latency.{extension}', dpi=180, facecolor=fig.get_facecolor())
    plt.close(fig)

    def link(path):
        return os.path.relpath(path, destination.parent)

    env = data['environment']
    first = data['samples'][0]
    lines = [
        '# Cold connection baseline', '',
        f"Measured {data['createdAt']} using harness commit `{env['git']}`.", '',
        f"{config['count']} fresh Node processes per driver and operation ({len(data['samples'])} samples total).",
        'The timer covers client construction through the first completed operation.',
        'These are local Docker measurements, not AWS Lambda cold-start measurements.', '',
        f"![Cold connection latency]({link(asset_dir / 'latency.png')})", '',
        '## Results', '',
        '| Operation | Client | Median (ms) | p95 (ms) | Mean (ms) | Range (ms) |',
        '| --- | --- | ---: | ---: | ---: | ---: |',
    ]
    for variant, operation in keys:
        s = summaries[(variant, operation)]
        lines.append(f"| {operation.title()} | {VARIANTS[variant]} | {s['median']:.2f} | {s['p95']:.2f} | {s['mean']:.2f} | {s['min']:.2f}–{s['max']:.2f} |")
    lines += ['', 'Differences in sample medians (positive means the wrapper took longer):', '']
    for operation in ['read', 'write']:
        normal = summaries[('native', operation)]['median']
        serverless = summaries[('serverless', operation)]['median']
        lines.append(f'- {operation.title()}: {serverless - normal:+.2f} ms ({(serverless / normal - 1) * 100:+.1f}%).')
    lines += ['', 'A single run does not establish a statistically significant performance difference.',
              'The normal driver can select the local primary before discovery of remote members finishes.',
              'The direct client also performs TCP, TLS, MongoDB handshake and authentication.', '',
              '### Mean phase timings', '',
              'The stacked chart uses means so its segments add to mean elapsed time. Medians of individual',
              'phases do not generally add to the median total. All values below are milliseconds.', '',
              '| Client / operation | ' + ' | '.join(PHASES.values()) + ' |',
              '| --- | ' + ' | '.join(['---:'] * len(PHASES)) + ' |']
    for key in keys:
        lines.append(f'| {VARIANTS[key[0]]} / {key[1]} | ' + ' | '.join(f"{summaries[key]['phases'][phase]:.2f}" for phase in PHASES) + ' |')
    lines += ['', '## Network and workload', '',
              f"The client and primary share simulated AZ A; two secondaries occupy AZ B and C. Injected RTT is {config['localRtt']} ms within AZ A and {config['crossRtt']} ms across AZs, split equally between packet directions.",
              'Measured RTTs below include Docker VM scheduling overhead. These are illustrative same-region',
              'values; AWS describes [single-digit millisecond AZ networking](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_fault_isolation_multiaz_region_system.html).', '',
              '| Source | Destination | Injected RTT (ms) | Measured ping mean (ms) |',
              '| --- | --- | ---: | ---: |']
    for network in data['network']:
        lines.append(f"| {network['source']} | {network['target']} | {network['configuredRttMs']:.2f} | {network['measuredRttMs']:.2f} |")
    lines += ['', '- Both clients use all three seeds, verified TLS, SCRAM-SHA-256, a one-connection pool and no retries.',
              '- Read: indexed `findOne` of an existing document on the primary. Write: one small `insertOne`, with majority acknowledgement.',
              '- Every result is checked. Driver order alternates within read/write pairs. No failures are discarded.',
              '- Topology is populated before timing; LocalPlugin reads its JSON from the process environment.',
              '- CPU scheduling, filesystem caches, database caches and the Docker VM remain warm.', '',
              '## Measurement limits', '',
              'TCP includes DNS; TLS is timed between TCP connect and secureConnect. Hello includes speculative',
              'authentication; Auth covers the remaining SCRAM provider work. Send measures serialization and',
              'socket buffering, not one-way network delivery. Receive/wait includes network transit, server',
              'execution, acknowledgement and decoding. Other/discovery is the residual elapsed time.', '',
              'Phases describe only the application socket. Concurrent discovery socket durations are retained',
              'in the raw traces but are not added to the total. Instrumentation runs in the benchmark process',
              'and leaves both driver implementations unchanged.', '',
              'Process launch, package imports, Lambda sandbox initialization, SRV DNS and fetching topology',
              'from a remote store are excluded. No jitter, loss or bandwidth cap is injected.', '',
              '## Reproduce', '', '```sh',
              f"npm run benchmark -- --samples {config['count']} --local-rtt {config['localRtt']} --cross-rtt {config['crossRtt']} --output benchmark/results/repeat.json",
              'python3 -m venv /tmp/mongodb-benchmark-plot',
              '/tmp/mongodb-benchmark-plot/bin/pip install -r benchmark/requirements-report.txt',
              '/tmp/mongodb-benchmark-plot/bin/python benchmark/report.py benchmark/results/repeat.json --output benchmark/results/BASELINE.md',
              '```', '',
              f"[Raw samples]({link(source)}) · [SVG plot]({link(asset_dir / 'latency.svg')}) · [Harness and phase definitions](benchmark/README.md)", '',
              '## Environment', '',
              f"- Node: `{first['nodeVersion']}`; MongoDB driver: `{first['driverVersion']}`.",
              f"- MongoDB: `{env['mongo'].splitlines()[0]}`.",
              f"- Client kernel: `{env['client']}`.",
              f"- Docker Engine: `{json.loads(env['docker'])['Version']}`.",
              '- Image identities and complete version metadata are included in the raw samples.', '',
              'Database credentials and generated certificate keys are not included in the results.', '']
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text('\n'.join(lines))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('samples', type=Path)
    parser.add_argument('--output', type=Path, default=Path('BASELINE.md'))
    args = parser.parse_args()
    render(json.loads(args.samples.read_text()), args.samples.resolve(), args.output.resolve())
