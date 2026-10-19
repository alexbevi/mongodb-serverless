"""Summarize verified cold Lambda samples without mixing write landing groups."""
import argparse
import json
import math
import importlib.util
from collections import Counter
from pathlib import Path
from statistics import median

VARIANTS = ['native', 'no-plugin', 'ssm']
LABELS = {'native': 'Native MongoDB', 'no-plugin': 'No plugin', 'ssm': 'SSM topology plugin'}


def percentile(values, fraction):
    values = sorted(values)
    rank = (len(values) - 1) * fraction
    lower = math.floor(rank)
    return values[lower] + (values[math.ceil(rank)] - values[lower]) * (rank - lower)


def statistics(samples):
    values = [sample['totalMs'] for sample in samples]
    if not values:
        return dict(count=0, medianMs=None, p95Ms=None, medianSsmMs=None)
    initializations = [sample.get('lambda', {}).get('initMs') for sample in samples]
    has_init = all(value is not None for value in initializations)
    return dict(count=len(values), medianMs=median(values), p95Ms=percentile(values, .95),
                medianSsmMs=median([sample['ssmMs'] for sample in samples]),
                medianExcludingSsmMs=median([sample['totalMs'] - sample['ssmMs'] for sample in samples]),
                sockets=dict(Counter(sample['sockets'] for sample in samples)),
                medianInitMs=median(initializations) if has_init else None,
                medianInitPlusHandlerMs=median([value + init for value, init in zip(values, initializations)]) if has_init else None)


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
        operations[operation] = groups
    writes = [sample for sample in samples if sample['variant'] == 'no-plugin' and sample['operation'] == 'write']
    landings = {}
    for name, sockets in [('oneConnection', 1), ('twoConnections', 2)]:
        group = statistics([sample for sample in writes if sample['sockets'] == sockets])
        group['sharePercent'] = group['count'] / len(writes) * 100
        landings[name] = group
    summary = dict(configuration=data['configuration'], operations=operations, writeLandings=landings)
    return summary


def markdown(summary):
    lines = ['| Operation / pattern | n | Median | p95 | SSM median |', '|---|---:|---:|---:|---:|']
    for operation, groups in summary['operations'].items():
        for variant, group in groups.items():
            lines.append(f"| {operation} / {LABELS[variant]} | {group['count']} | {group['medianMs']:.1f} ms | {group['p95Ms']:.1f} ms | {group['medianSsmMs']:.1f} ms |")
    for name, group in summary['writeLandings'].items():
        if group['count']:
            label = 'lucky write, 1 connection' if name == 'oneConnection' else 'write, 2 connections'
            lines.append(f"| No plugin / {label} | {group['count']} | {group['medianMs']:.1f} ms | {group['p95Ms']:.1f} ms | {group['medianSsmMs']:.1f} ms |")
    if all(group.get('medianInitMs') is not None for groups in summary['operations'].values() for group in groups.values()):
        lines.extend(['', '| Pattern | Median INIT | Median INIT + handler |', '|---|---:|---:|'])
        for operation, groups in summary['operations'].items():
            for variant in ['no-plugin', 'ssm']:
                group = groups[variant]
                lines.append(f"| {operation} / {LABELS[variant]} | {group['medianInitMs']:.1f} ms | {group['medianInitPlusHandlerMs']:.1f} ms |")
        lines.extend(['', 'INIT + handler excludes Lambda provisioning, invocation transport, and close. All variants load the same benchmark package.'])
    lines.extend(['', 'Timings include SSM through the operation result; Lambda INIT and client close are separate. Write landing groups occur naturally and have unequal sample counts.'])
    lines.extend(['', '![Measured connection breakdown](latency.png)', '', 'Each panel shows a measured trace nearest its cohort median. The timeline accounts for SSM, DNS, all MongoDB connections, authentication, discovery, role validation, the operation, measured code scopes, and callback/dispatch time. Parallel socket lanes overlap and must not be added. Detailed probes add overhead.'])
    title = summary['configuration'].get('environment', 'Cold Lambda')
    count = summary['configuration']['count']
    return f'# {title} results\n\n{count} cold invocations per driver/operation case.\n' + '\n'.join(lines) + '\n'


spec = importlib.util.spec_from_file_location('breakdown', Path(__file__).with_name('report.py'))
breakdown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(breakdown)


def timeline(sample):
    trace = sample['trace']
    if not trace.get('execution') or not trace.get('activities'):
        raise ValueError('Full diagnostics are required; collect a new measured run')
    start = trace['start']
    command = trace['command']
    connections = []
    for socket in trace['sockets']:
        phases = {phase: [value - start for value in socket[phase]]
                  for phase in ['lookup', 'tcp', 'tls', 'hello', 'auth'] if phase in socket}
        connections.append(dict(host=socket['host'], role=socket.get('role', 'UNKNOWN'),
            kind='application' if 'auth' in socket else 'monitor',
            selected=socket['start'] == command['socket']['start'],
            start=socket['start'] - start, end=max(interval[1] for interval in phases.values()), phases=phases))
    requests = [dict(phase='ssm', start=call['start'] - start, end=call['end'] - start) for call in trace['ssm']]
    for exchange in trace.get('exchanges', []):
        phase = 'discovery' if exchange['name'] == 'replSetGetStatus' else 'roleCheck' if exchange['name'] == 'hello' and exchange['start'] != exchange['socket'].get('hello', [None])[0] else None
        if phase:
            requests.append(dict(phase=phase, start=exchange['start'] - start, end=exchange['end'] - start))
    return dict(total=sample['totalMs'], connections=connections, requests=requests,
        dns=[dict(kind=q['kind'], start=q['start'] - start, end=q['end'] - start) for q in trace['dns']],
        command=dict(send=[command['start'] - start, command['sent'] - start], receive=[command['sent'] - start, command['end'] - start]),
        execution=[{**span, 'start': span['start'] - start, 'end': span['end'] - start} for span in trace['execution']['segments']],
        activities=[{**span, 'start': span['start'] - start, 'end': span['end'] - start} for span in trace['activities']],
        threadCpuMs=trace['execution']['threadCpuMs'])


def illustrated_cases(data):
    cases = []
    for operation in ['read', 'write']:
        for variant in VARIANTS:
            cohort = [sample for sample in data['samples'] if sample['operation'] == operation and sample['variant'] == variant]
            groups = [(LABELS[variant], cohort)]
            if operation == 'write' and variant == 'no-plugin':
                groups = [(f'No plugin · {sockets} connection' + ('s' if sockets == 2 else ''),
                           [sample for sample in cohort if sample['sockets'] == sockets]) for sockets in [1, 2]]
            for label, group in groups:
                if group:
                    middle = median(sample['totalMs'] for sample in group)
                    representative = min(group, key=lambda sample: abs(sample['totalMs'] - middle))
                    cases.append(dict(operation=operation, label=label, statistics=statistics(group),
                                      sample=representative, timeline=timeline(representative)))
    return cases


def render(data, summary, output):
    plt = breakdown.plt
    cases = illustrated_cases(data)
    # Validate every sample, not only the illustrated traces.
    for sample in data['samples']:
        breakdown.accounting_segments(timeline(sample))
    figure, axes = plt.subplots(4, 2, figsize=(23, 20))
    maximum = max(case['timeline']['total'] for case in cases) * 1.14
    summary['illustratedTraces'] = []
    visible = set()
    for column, operation in enumerate(['read', 'write']):
        current = [case for case in cases if case['operation'] == operation]
        for axis, case in zip(axes[:, column], current):
            measured = case['timeline']
            connections = measured['connections']
            selected = next(index for index, connection in enumerate(connections) if connection['selected'])
            segments = breakdown.accounting_segments(measured)
            visible.update(segment['phase'] for segment in breakdown.display_segments(segments))
            visible.update(phase for connection in connections for phase in connection['phases'])
            lanes = list(range(len(connections), 0, -1))
            y = lanes[selected]
            for index, connection in enumerate(connections):
                breakdown.draw_connection(axis, connection, lanes[index], measured)
            breakdown.draw_gaps(axis, measured, y)
            for segment in segments:
                phase = segment['phase']
                if phase in ['ssm', 'clusterDns', 'discovery', 'roleCheck']:
                    axis.barh(y, segment['end'] - segment['start'], left=segment['start'], height=.36, color=breakdown.COLORS[phase], zorder=4)
            breakdown.draw_command(axis, measured, y)
            breakdown.draw_off_cpu(axis, measured, y)
            first = min(connection['start'] for connection in connections)
            command_start = measured['command']['send'][0]
            for label, begin, end in [('Setup', 0, first), ('Connections & topology', first, command_start), ('Operation', command_start, measured['total'])]:
                bracket = len(connections) + .58
                axis.plot([begin, begin, end, end], [bracket-.06, bracket, bracket, bracket-.06], color='#64748b', linewidth=.7)
                # Small operation labels sit on the right to avoid the neighboring bracket.
                axis.text(end if label == 'Operation' else (begin+end)/2, bracket+.08,
                          f'{label}\n{end-begin:.1f} ms', fontsize=8, ha='left' if label == 'Operation' else 'center')
            labels = [f"{'Application' if c['kind'] == 'application' else 'Monitor'}\n{c['role'].capitalize()} · {c['host']}" for c in connections]
            axis.set_yticks(lanes, labels, fontsize=8)
            for label, connection in zip(axis.get_yticklabels(), connections):
                if connection['role'] == 'PRIMARY':
                    label.set_fontweight('bold')
            axis.set_ylim(0, len(connections)+1.4)
            axis.set_xlim(0, maximum)
            stats = case['statistics']
            axis.set_title(f"{operation.title()} · {case['label']}\nMedian {stats['medianMs']:.1f} ms · p95 {stats['p95Ms']:.1f} ms · n={stats['count']}", loc='left', fontsize=12, weight='bold', pad=14)
            axis.set_xlabel('Milliseconds since handler invocation', fontsize=9)
            axis.grid(axis='x', alpha=.15)
            axis.set_axisbelow(True)
            axis.spines[['top', 'right', 'left']].set_visible(False)
            axis.text(0, -.31, breakdown.cpu_annotation(measured), transform=axis.transAxes, fontsize=8, color='#475569')
            summary['illustratedTraces'].append(dict(operation=operation, pattern=case['label'],
                iteration=case['sample'].get('iteration'), totalMs=measured['total'],
                accountingMs=breakdown.accounting_totals(measured), segments=segments))
        for axis in axes[len(current):, column]:
            axis.set_visible(False)
    groups = {'Setup': ['ssm', 'clusterDns'], 'Connection': ['lookup', 'tcp', 'tls', 'hello', 'auth', 'monitor', 'discovery', 'roleCheck'], 'Code & scheduling': ['callback', 'dispatch'], 'Operation': ['send', 'receive']}
    groups['Code & scheduling'] += sorted(phase for phase in visible if phase.startswith('code:'))
    for (title, phases), x in zip(groups.items(), [.06, .27, .49, .79]):
        handles = [breakdown.Patch(facecolor=breakdown.COLORS.get(phase) or breakdown.phase_color(phase),
                   label=breakdown.phase_label(phase)) for phase in phases if phase in visible]
        legend = figure.legend(handles=handles, title=title, loc='upper left', bbox_to_anchor=(x,.21), fontsize=8, title_fontsize=11, frameon=False)
        legend.get_title().set_fontweight('bold')
    configuration = data['configuration']
    figure.suptitle(f"Cold Lambda connection breakdown · {configuration['environment']}", x=.08, ha='left', y=.985, fontsize=23, weight='bold')
    figure.text(.08,.95, f"Measured {data.get('createdAt', '')[:10]} · {configuration['count']} cold invocations per pattern/operation · {configuration['memoryMB']} MB · MongoDB driver 7.7.0\nEach panel shows one measured trace nearest its cohort median. Detailed code and callback probes are enabled.", fontsize=12)
    figure.text(.08,.025, 'SSM through operation result; Lambda INIT and client close are outside the timeline. Concurrent socket lanes must not be added.\nEvery measured millisecond is accounted for. Other callbacks and dispatch retain time without inferring its cause. Hatching marks callbacks with ≥2 ms off CPU.\nLocalStack timings do not predict AWS latency. Results describe the recorded runtime, cluster and measurement window.', fontsize=10)
    figure.subplots_adjust(left=.08, right=.97, top=.89, bottom=.27, hspace=.9, wspace=.28)
    figure.savefig(output, dpi=150, facecolor='white')
    plt.close(figure)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('samples', type=Path)
    args = parser.parse_args()
    data = json.loads(args.samples.read_text())
    summary = summarize(data)
    render(data, summary, args.samples.with_name('latency.png'))
    args.samples.with_name('summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    args.samples.with_name('results.md').write_text(markdown(summary))
    print(markdown(summary))
