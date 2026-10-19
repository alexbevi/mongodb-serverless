"""Report cold Lambda latency, variability, and complete connection timelines."""
import argparse
import json
import math
import importlib.util
from collections import Counter
from pathlib import Path
from statistics import mean, median, stdev

VARIANTS = ['native', 'no-plugin', 'ssm']
LABELS = {'native': 'Native MongoDB', 'no-plugin': 'No plugin', 'ssm': 'aws-ssm · cached topology'}


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
                meanMs=mean(values), standardDeviationMs=stdev(values) if len(values) > 1 else None,
                coefficientOfVariationPercent=100 * stdev(values) / mean(values) if len(values) > 1 else None,
                medianAbsoluteDeviationMs=median(abs(value - median(values)) for value in values),
                medianSsmMs=median([sample['ssmMs'] for sample in samples]),
                medianExcludingSsmMs=median([sample['totalMs'] - (sample['ssmMs'] if sample.get('ssmPhase') != 'init' else 0) for sample in samples]),
                sockets=dict(Counter(sample['sockets'] for sample in samples)),
                medianInitMs=median(initializations) if has_init else None,
                p95InitPlusHandlerMs=percentile([value + init for value, init in zip(values, initializations)], .95) if has_init else None,
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
    summary = dict(measuredAt=data.get('createdAt'),
                   runtimes=sorted({sample['nodeVersion'] for sample in samples if 'nodeVersion' in sample}),
                   initSources=sorted({sample.get('lambda', {}).get('initSource', 'not-recorded') for sample in samples}),
                   configuration={key: value for key, value in data['configuration'].items() if key != 'preparation'},
                   operations=operations, writeLandings=landings)
    return summary


def markdown(summary):
    def duration(value):
        return f'{value:.1f} ms' if value is not None else '—'

    lines = ['| Operation / pattern | n | Handler median | Handler p95 | INIT median | SSM median | INIT + handler median |',
             '|---|---:|---:|---:|---:|---:|---:|']
    groups = [(f'{operation} / {LABELS[variant]}', group) for operation, variants in summary['operations'].items() for variant, group in variants.items()]
    groups += [('No plugin / ' + ('lucky write, 1 connection' if name == 'oneConnection' else 'write, 2 connections'), group)
               for name, group in summary['writeLandings'].items() if group['count']]
    for label, group in groups:
        values = [duration(group.get(key)) for key in ['medianMs', 'p95Ms', 'medianInitMs', 'medianSsmMs', 'medianInitPlusHandlerMs']]
        lines.append(f"| {label} | {group['count']} | " + ' | '.join(values) + ' |')
    configuration = summary['configuration']
    lines += ['', 'SSM is fetched during INIT. Handler latency starts after that fetch and ends at the operation result. INIT + handler is calculated per invocation before taking the median. The client is created lazily and retained for warm calls.',
              '', 'INIT includes runtime and module initialization. Provisioning, caller transport, and post-result reporting are outside the measured interval. Detailed probes add overhead. Write landing groups occur naturally and have unequal sample counts.']
    if summary.get('initSources') == ['node-process-clock']:
        lines += ['', 'LocalStack omits INIT duration from its log tail. INIT here measures the Node performance clock from process startup until module initialization completes. It excludes container provisioning and is not AWS-reported INIT.']
    if configuration.get('packageZipBytes'):
        lines += ['', f"Deployment package: {configuration['packageZipBytes']:,} bytes ZIP; identical for all patterns, including both drivers and diagnostic probes."]
    checks = configuration.get('warmVerification', [])
    if checks:
        lines += ['', f'{len(checks)} separate warm checks verified environment and client reuse, without further SSM requests, cluster DNS or discovery. Serverless calls reused their direct sockets. A native nearest read may open a pool connection to another member.',
                  '', '| Warm check | Handler time | Serving role |', '|---|---:|---|']
        lines += [f"| {check['operation']} / {LABELS[check['variant']]} | {check['totalMs']:.1f} ms | {check['servedRole']} |" for check in checks]
        lines += ['', 'One warm invocation per case validates reuse; these timings are not a warm latency distribution.']
    lines += ['', '![Measured connection breakdown](latency.png)', '',
              'Each panel shows a real invocation nearest its cohort median of INIT + handler time. INIT and its SSM request are shown above the handler detail. Each socket has its own row; DNS and other work have separate rows. Parallel rows must not be added. The summary accounts for every measured millisecond once.']
    title = configuration.get('environment', 'Cold Lambda')
    count = configuration['count']
    return f"# {title} results\n\nMeasured {summary.get('measuredAt') or 'date not recorded'} · Node {', '.join(summary['runtimes']) or 'not recorded'}.\n\n{count} cold invocations per driver/operation case.\n\n" + '\n'.join(lines) + '\n'


spec = importlib.util.spec_from_file_location('breakdown', Path(__file__).with_name('report.py'))
breakdown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(breakdown)
codec_spec = importlib.util.spec_from_file_location('compact', Path(__file__).with_name('compact.py'))
codec = importlib.util.module_from_spec(codec_spec)
codec_spec.loader.exec_module(codec)


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


def handler_lanes(sample):
    trace = sample['trace']
    start = trace['start']
    measured = timeline(sample)
    spans = breakdown.accounting_segments(measured)
    lanes = [dict(kind='ssm', label='SSM · decrypted parameters', spans=[
        dict(phase='ssm', start=call['start']-start, end=call['end']-start) for call in trace['ssm']])]
    if not trace['ssm']:
        lanes = []
    if trace['dns']:
        lanes.append(dict(kind='dns', label='Cluster DNS · SRV + TXT', spans=[
            dict(phase='clusterDns', start=query['start']-start, end=query['end']-start) for query in trace['dns']]))
    for socket in trace['sockets']:
        events = [dict(phase=phase, start=socket[phase][0]-start, end=socket[phase][1]-start)
                  for phase in ['lookup', 'tcp', 'tls', 'hello', 'auth'] if phase in socket]
        for exchange in trace.get('exchanges', []):
            if exchange['socket']['start'] != socket['start']:
                continue
            phase = 'discovery' if exchange['name'] == 'replSetGetStatus' else 'roleCheck' if exchange['name'] == 'hello' and exchange['start'] != socket.get('hello', [None])[0] else None
            if phase and exchange['end'] <= trace['end']:
                events.append(dict(phase=phase, start=exchange['start']-start, end=exchange['end']-start))
        selected = trace['command']['socket']['start'] == socket['start']
        if selected:
            events.extend(dict(phase=phase, start=interval[0], end=interval[1]) for phase, interval in measured['command'].items())
        role = socket.get('role', 'UNKNOWN').capitalize()
        kind = 'Application' if 'auth' in socket else 'Monitor'
        lanes.append(dict(kind='connection', label=f'{kind} · {role} · {socket["host"]}', spans=events, selected=selected))
    code = [dict(span) for span in spans
            if span['phase'].startswith('code:') or span['phase'] in ['callback', 'dispatch']]
    lanes.append(dict(kind='code', label='Other handler work / scheduling', spans=code))
    return lanes


def cold_accounting(sample):
    totals = breakdown.accounting_totals(timeline(sample))
    init = sample['lambda']['initMs']
    ssm = sum(call['end'] - call['start'] for call in sample.get('initialization', {}).get('ssm', []))
    if ssm > init:
        raise ValueError('SSM duration exceeds recorded INIT')
    totals['init'] = init - ssm
    totals['ssm'] += ssm
    return totals


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
                    middle = median(sample['totalMs'] + sample['lambda']['initMs'] for sample in group)
                    representative = min(group, key=lambda sample: abs(sample['totalMs'] + sample['lambda']['initMs'] - middle))
                    cases.append(dict(operation=operation, label=label, statistics=statistics(group),
                                      sample=representative, timeline=timeline(representative)))
    return cases


def render(data, summary, output):
    codec.expand_diagnostics(data)
    plt = breakdown.plt
    cases = illustrated_cases(data)
    # Validate every sample, not only the illustrated traces.
    for sample in data['samples']:
        breakdown.accounting_segments(timeline(sample))
    figure, axes = plt.subplots(4, 2, figsize=(25, 23))
    maximum = max(case['timeline']['total'] for case in cases) * 1.14
    summary['illustratedTraces'] = []
    visible = set()
    for column, operation in enumerate(['read', 'write']):
        current = [case for case in cases if case['operation'] == operation]
        for axis, case in zip(axes[:, column], current):
            measured = case['timeline']
            lanes = handler_lanes(case['sample'])
            segments = breakdown.accounting_segments(measured)
            visible.update(span['phase'] for lane in lanes for span in lane['spans'])
            for index, lane in enumerate(lanes):
                y = len(lanes)-index
                for span in lane['spans']:
                    phase = span['phase']
                    axis.barh(y, span['end']-span['start'], left=span['start'], height=.36,
                              color=breakdown.COLORS.get(phase) or breakdown.phase_color(phase))
                if lane['kind'] == 'code':
                    breakdown.draw_off_cpu(axis, measured, y)
            axis.set_yticks(list(reversed(range(1, len(lanes)+1))), [lane['label'] for lane in lanes], fontsize=8)
            axis.set_ylim(0, len(lanes)+1)
            axis.set_xlim(0, maximum)
            stats = case['statistics']
            variation = f"SD {stats['standardDeviationMs']:.1f} ms · CV {stats['coefficientOfVariationPercent']:.1f}%" if stats['count'] > 1 else 'SD / CV unavailable for n=1'
            init = case['sample']['lambda']['initMs']
            init_ssm = sum(call['end']-call['start'] for call in case['sample'].get('initialization', {}).get('ssm', []))
            axis.set_title(f"{operation.title()} · {case['label']}\nCold median {stats['medianInitPlusHandlerMs']:.1f} ms · p95 {stats['p95InitPlusHandlerMs']:.1f} ms · n={stats['count']}\nShown INIT {init:.1f} ms (SSM {init_ssm:.1f} ms included) + handler {measured['total']:.1f} ms\nHandler mean {stats['meanMs']:.1f} ms · {variation}", loc='left', fontsize=10, weight='bold', pad=14)
            axis.set_xlabel('Milliseconds since handler measurement started · SSM completed during INIT', fontsize=9)
            axis.grid(axis='x', alpha=.15)
            axis.set_axisbelow(True)
            axis.spines[['top', 'right', 'left']].set_visible(False)
            axis.text(0, -.31, breakdown.cpu_annotation(measured), transform=axis.transAxes, fontsize=8, color='#475569')
            summary['illustratedTraces'].append(dict(operation=operation, pattern=case['label'],
                iteration=case['sample'].get('iteration'), totalMs=init+measured['total'], initMs=init, handlerMs=measured['total'],
                accountingMs=cold_accounting(case['sample']), segments=segments))
        for axis in axes[len(current):, column]:
            axis.set_visible(False)
    groups = {'Setup': ['ssm', 'clusterDns'], 'Connection': ['lookup', 'tcp', 'tls', 'hello', 'auth', 'monitor', 'discovery', 'roleCheck'], 'Code & scheduling': ['callback', 'dispatch'], 'Operation': ['send', 'receive']}
    groups['Code & scheduling'] += sorted(phase for phase in visible if phase.startswith('code:'))
    for (title, phases), x in zip(groups.items(), [.06, .27, .49, .79]):
        handles = [breakdown.Patch(facecolor=breakdown.COLORS.get(phase) or breakdown.phase_color(phase),
                   label=breakdown.phase_label(phase).removeprefix('Application ')) for phase in phases if phase in visible]
        legend = figure.legend(handles=handles, title=title, loc='upper left', bbox_to_anchor=(x,.21), fontsize=8, title_fontsize=11, frameon=False, ncol=2 if title == 'Code & scheduling' else 1, columnspacing=1)
        legend.get_title().set_fontweight('bold')
    configuration = data['configuration']
    figure.suptitle(f"Cold Lambda connection breakdown · {configuration['environment']}", x=.08, ha='left', y=.985, fontsize=23, weight='bold')
    figure.text(.08,.95, f"Measured {data.get('createdAt', '')[:10]} · {configuration['count']} cold invocations per pattern/operation · {configuration['memoryMB']} MB · MongoDB driver 7.7.0\nOne real invocation nearest each cold cohort median. INIT includes SSM; timelines below show the handler. Detailed probes are enabled.", fontsize=12)
    package = configuration.get('packageZipBytes', 0)
    init_source = 'Local INIT uses the Node process clock; AWS INIT uses Lambda REPORT.'
    figure.text(.08,.025, f'{init_source} INIT includes runtime, modules and SSM. Remaining INIT time has no internal phase split. Handler lanes overlap and must not be added.\nThe client is retained for warm invocations. Hatching marks callbacks with ≥2 ms off CPU. Provisioning and caller transport are outside the measurement.\nPackage {package/1e6:.2f} MB ZIP · same bundle for all cases. LocalStack timings do not predict AWS latency.', fontsize=10)
    figure.subplots_adjust(left=.12, right=.97, top=.89, bottom=.27, hspace=1.1, wspace=.4)
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
