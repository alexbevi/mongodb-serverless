"""Summarize verified cold Lambda samples without mixing write landing groups."""
import argparse
import json
import math
from pathlib import Path
from statistics import median

VARIANTS = ['native', 'main', 'no-plugin', 'ssm']
LABELS = {'native': 'Native MongoDB', 'main': 'Main + stored topology', 'no-plugin': 'No plugin', 'ssm': 'SSM topology plugin'}


def percentile(values, fraction):
    values = sorted(values)
    rank = (len(values) - 1) * fraction
    lower = math.floor(rank)
    return values[lower] + (values[math.ceil(rank)] - values[lower]) * (rank - lower)


def statistics(samples):
    values = [sample['totalMs'] for sample in samples]
    if not values:
        return dict(count=0, medianMs=None, p95Ms=None, medianSsmMs=None)
    return dict(count=len(values), medianMs=median(values), p95Ms=percentile(values, .95),
                medianSsmMs=median([sample['ssmMs'] for sample in samples]))


def improvement(value, baseline):
    return None if value is None else 100 * (1 - value / baseline)


def summarize(data):
    if data['failures']:
        raise ValueError('Cannot summarize a run with failures')
    samples = data['samples']
    if any(not sample['verified'] or not sample['cold'] for sample in samples):
        raise ValueError('Every sample must be verified and cold')
    operations = {}
    for operation in ['read', 'write']:
        groups = {variant: statistics([sample for sample in samples if sample['variant'] == variant and sample['operation'] == operation]) for variant in VARIANTS}
        if any(group['count'] != data['configuration']['count'] for group in groups.values()):
            raise ValueError('Sample count differs from the requested cohort')
        for group in groups.values():
            group['improvementVsMainPercent'] = improvement(group['medianMs'], groups['main']['medianMs'])
            group['improvementVsNativePercent'] = improvement(group['medianMs'], groups['native']['medianMs'])
        operations[operation] = groups
    writes = [sample for sample in samples if sample['variant'] == 'no-plugin' and sample['operation'] == 'write']
    landings = {}
    for name, sockets in [('oneConnection', 1), ('twoConnections', 2)]:
        group = statistics([sample for sample in writes if sample['sockets'] == sockets])
        group['sharePercent'] = group['count'] / len(writes) * 100
        group['improvementVsMainPercent'] = improvement(group['medianMs'], operations['write']['main']['medianMs'])
        group['improvementVsNativePercent'] = improvement(group['medianMs'], operations['write']['native']['medianMs'])
        landings[name] = group
    return dict(configuration=data['configuration'], operations=operations, writeLandings=landings)


def markdown(summary):
    lines = ['| Operation / pattern | n | Median | p95 | vs main | vs native |', '|---|---:|---:|---:|---:|---:|']
    for operation, groups in summary['operations'].items():
        for variant, group in groups.items():
            lines.append(f"| {operation} / {LABELS[variant]} | {group['count']} | {group['medianMs']:.1f} ms | {group['p95Ms']:.1f} ms | {group['improvementVsMainPercent']:+.1f}% | {group['improvementVsNativePercent']:+.1f}% |")
    for name, group in summary['writeLandings'].items():
        if group['count']:
            label = 'lucky write, 1 connection' if name == 'oneConnection' else 'write, 2 connections'
            lines.append(f"| No plugin / {label} | {group['count']} | {group['medianMs']:.1f} ms | {group['p95Ms']:.1f} ms | {group['improvementVsMainPercent']:+.1f}% | {group['improvementVsNativePercent']:+.1f}% |")
    lines.extend(['', 'Positive percentages mean lower median latency. Timings include SSM through the operation result; Lambda INIT and client close are separate. Write landing groups occur naturally and have unequal sample counts.'])
    return '\n'.join(lines) + '\n'


def render(data, summary, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    colors = ['#5D6B82', '#9845B5', '#008F86', '#D77518']
    figure, axes = plt.subplots(1, 3, figsize=(16, 7), gridspec_kw={'width_ratios': [1.2, 1.2, 1]})
    figure.patch.set_facecolor('#F6F8FC')
    for axis in axes:
        axis.set_facecolor('#F6F8FC')
        axis.spines[['top', 'right', 'left']].set_visible(False)
        axis.grid(axis='y', color='#DBE1EB', linewidth=.7)
        axis.set_axisbelow(True)
        axis.set_ylabel('Milliseconds · median and p95')
    for axis, operation in zip(axes[:2], ['read', 'write']):
        groups = summary['operations'][operation]
        for index, variant in enumerate(VARIANTS):
            group = groups[variant]
            axis.bar(index, group['medianMs'], color=colors[index], width=.62)
            axis.plot([index, index], [group['medianMs'], group['p95Ms']], color=colors[index], linewidth=2)
            axis.plot(index, group['p95Ms'], '_', color=colors[index], markersize=12)
            axis.text(index, group['p95Ms'], f"{group['medianMs']:.1f}\nn={group['count']}", ha='center', va='bottom', fontsize=10)
        axis.set_xticks(range(4), ['Native', 'Main\ncached', 'No\nplugin', 'SSM\ncached'])
        axis.set_ylim(0, max(group['p95Ms'] for group in groups.values()) * 1.28)
        axis.set_title('Reads · any healthy member' if operation == 'read' else 'Writes · primary only', loc='left', weight='bold', pad=18)
    axis = axes[2]
    for index, (name, group) in enumerate(summary['writeLandings'].items()):
        if not group['count']:
            continue
        axis.bar(index, group['medianMs'], color=['#008F86', '#DBA73B'][index], width=.55)
        axis.plot([index, index], [group['medianMs'], group['p95Ms']], color='#42516B', linewidth=2)
        axis.text(index, group['p95Ms'], f"{group['medianMs']:.1f}\nn={group['count']} ({group['sharePercent']:.0f}%)", ha='center', va='bottom', fontsize=10)
    axis.set_xticks([0, 1], ['Lucky primary\n1 connection', 'Secondary seed\n2 connections'])
    axis.set_ylim(0, max(group['p95Ms'] or 0 for group in summary['writeLandings'].values()) * 1.28)
    axis.set_title('No plugin · random write landing', loc='left', weight='bold', pad=18)
    environment = data['configuration']['environment']
    figure.suptitle(f'MongoDB cold Lambda connections · {environment}', x=.06, ha='left', fontsize=22, weight='bold', y=.96)
    figure.text(.06, .87, 'SSM SecureString read + connection + first operation. Every sample uses a fresh Lambda version.', fontsize=12, color='#42516B')
    figure.text(.06, .07, f"Main baseline {data['configuration']['baseline'][:12]} · {data['configuration']['memoryMB']} MB · TLS verified · MongoDB driver 7.7.0", fontsize=11, color='#42516B')
    figure.text(.06, .035, 'Bars show medians; ticks show p95. Excludes Lambda INIT and client close. LocalStack timings do not predict AWS latency.', fontsize=10, color='#42516B')
    figure.subplots_adjust(left=.06, right=.98, bottom=.22, top=.77, wspace=.34)
    figure.savefig(output, dpi=160, facecolor=figure.get_facecolor())
    plt.close(figure)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('samples', type=Path)
    args = parser.parse_args()
    data = json.loads(args.samples.read_text())
    summary = summarize(data)
    args.samples.with_name('summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    args.samples.with_name('results.md').write_text(markdown(summary))
    render(data, summary, args.samples.with_name('latency.png'))
    print(markdown(summary))
