#!/usr/bin/env python3
"""Summarize and chart cold operations from event traces.

Usage: python3 benchmark/report.py <samples.json>
Writes summary.json, results.md and one chart per case beside it.
"""
import argparse
import gzip
import json
import math
from collections import Counter
from pathlib import Path
from statistics import mean, median, stdev

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch

VARIANTS = ['native', 'no-plugin', 'ssm', 'ssm-uncached']
LABELS = {'native': 'Native MongoDB', 'no-plugin': 'No plugin', 'ssm': 'aws-ssm · cached topology',
          'ssm-uncached': 'aws-ssm · no cached topology'}
SHORT = {'native': 'native', 'no-plugin': 'no plugin', 'ssm': 'cached', 'ssm-uncached': 'uncached'}

PHASES = {
    'setup': ('Setup before the first member connection', '#64748b'),
    'ssm': ('SSM parameter request', '#475569'),
    'topologyStore': ('SSM topology write', '#0f766e'),
    'monitor': ('Monitor handshakes', '#ddd6fe'),
    'lookup': ('Host DNS', '#854d0e'),
    'tcp': ('TCP connect', '#2563eb'),
    'tls': ('TLS handshake', '#38bdf8'),
    'hello': ('Initial hello', '#a78bfa'),
    'auth': ('Authentication', '#f59e0b'),
    'discovery': ('Topology discovery (replSetGetStatus)', '#b45309'),
    'routing': ('Topology parsing and member selection', '#7c3aed'),
    'checkout': ('Connection checkout wait', '#db2777'),
    'prepare': ('Command preparation', '#0e7490'),
    'operation': ('Operation command → reply', '#10b981'),
    'result': ('Reply → result returned', '#fb7185'),
    'other': ('Other handler work', '#94a3b8'),
}
SOCKET_PHASES = ['lookup', 'tcp', 'tls', 'hello', 'auth']

# Setup has no events inside it, so its composition comes from an earlier run
# with code probes (AWS, commit 1663157), excluding the probes' own overhead.
# SRV + TXT DNS uses the later protocol-only AWS run (commit 050f98b), which
# timed the DNS queries directly. Values are relative weights, not milliseconds.
SETUP_STEPS = {
    'pluginRead': 'Plugin topology read',
    'parse': 'URI and option parsing',
    'dns': 'SRV + TXT DNS',
    'construct': 'Client and topology construction',
    'noMonitoring': 'No-monitoring module load',
    'metadata': 'Driver runtime metadata',
}
SETUP_WEIGHTS = {
    'native': {'parse': 9.8, 'dns': 5.0, 'construct': 13.4, 'metadata': 10.8},
    'no-plugin': {'parse': 10.0, 'dns': 2.3, 'construct': 7.3, 'metadata': 27.6},
    'ssm': {'pluginRead': 0.5, 'parse': 14.2, 'construct': 19.1, 'noMonitoring': 18.2, 'metadata': 27.2},
    'ssm-uncached': {'pluginRead': 0.5, 'parse': 10.0, 'dns': 2.2, 'construct': 7.3, 'metadata': 27.6},
}
SETUP_SHADES = {'pluginRead': '#334155', 'parse': '#4338ca', 'dns': '#6366f1', 'construct': '#818cf8',
                'noMonitoring': '#a5b4fc', 'metadata': '#c7d2fe'}


def setup_estimates(variant, setup_ms):
    """Splits a measured setup interval in its historical proportions."""
    weights = SETUP_WEIGHTS[variant]
    total = sum(weights.values())
    return [(step, setup_ms * weights[step] / total) for step in SETUP_STEPS if step in weights]


def setup_interval(sample):
    """Handler entry until the first socket to any member opens; None when no socket opened."""
    trace = sample['trace']
    if not trace['sockets']:
        return None
    return 0, min(socket['start'] for socket in trace['sockets']) - trace['start']


def intervals(sample):
    """Every timed interval, relative to the measurement start, highest priority first."""
    trace = sample['trace']
    start = trace['start']
    command = trace['command']

    def relative(interval):
        return interval[0] - start, interval[1] - start

    # (phase, start, end, member); member is set only where the phase belongs to one member's row.
    result = []
    for call in trace.get('ssm', []):
        phase = 'topologyStore' if call.get('command') == 'PutParameterCommand' else 'ssm'
        result.append((phase, *relative((call['start'], call['end'])), None))
    result += [('discovery', *relative((c['start'], c['end'])), None) for c in trace['commands'] if c['name'] == 'replSetGetStatus']
    result.append(('operation', *relative((command['start'], command['end'])), None))
    applications = [s for s in trace['sockets'] if s['kind'] == 'application']
    applications.sort(key=lambda s: s['start'] != command['socket']['start'])
    result += [(phase, *relative(s[phase]), None) for s in applications for phase in SOCKET_PHASES if phase in s]
    setup = setup_interval(sample)
    if setup:
        result.append(('setup', *setup, None))
    result += [('monitor', *relative(s[phase]), None) for s in trace['sockets'] if s['kind'] == 'monitor'
               for phase in SOCKET_PHASES if phase in s]
    result += [('checkout', *relative((c['start'], c['end'])), c['address'].rsplit(':', 1)[0]) for c in trace.get('checkouts', [])]
    return result


def gap_markers(sample):
    """Events that explain the untimed work after them: (relative time, phase of the following gap)."""
    trace = sample['trace']
    start = trace['start']
    markers = [(s['auth'][1] - start, 'prepare', s['host']) for s in trace['sockets'] if s['kind'] == 'application' and 'auth' in s]
    markers += [(c['end'] - start, 'routing', None) for c in trace['commands'] if c['name'] == 'replSetGetStatus']
    markers += [(c['end'] - start, 'routing', None) for c in trace.get('ssm', []) if c.get('command') == 'PutParameterCommand']
    markers.append((trace['command']['end'] - start, 'result', None))
    return sorted(markers, key=lambda marker: marker[0])


def accounting_segments(sample):
    """Assigns each instant of the handler measurement to its highest-priority phase.

    Untimed gaps take their name from the event before them: a ready connection
    precedes command preparation, a discovery reply precedes member selection,
    and the operation's reply precedes returning the result.
    """
    total = sample['totalMs']
    timed = intervals(sample)
    markers = gap_markers(sample)
    boundaries = sorted({0, total, *(max(0, min(total, t)) for _, a, b, _member in timed for t in (a, b))})
    segments = []
    for a, b in zip(boundaries, boundaries[1:]):
        phase, member = next(((phase, owner) for phase, left, right, owner in timed if left <= a and b <= right), (None, None))
        if phase is None:
            phase, member = next(((label, host) for at, label, host in reversed(markers) if at <= a + 1e-9), ('other', None))
        if segments and segments[-1]['phase'] == phase and segments[-1].get('member') == member:
            segments[-1]['end'] = b
        else:
            segments.append({'phase': phase, 'start': a, 'end': b, **({'member': member} if member else {})})
    return segments


def accounting_totals(sample):
    totals = dict.fromkeys(PHASES, 0.0)
    for segment in accounting_segments(sample):
        totals[segment['phase']] += segment['end'] - segment['start']
    return totals


def percentile(values, fraction):
    values = sorted(values)
    rank = (len(values) - 1) * fraction
    lower = math.floor(rank)
    return values[lower] + (values[math.ceil(rank)] - values[lower]) * (rank - lower)


def statistics(samples):
    values = [s['totalMs'] for s in samples]
    if not values:
        return dict(count=0)
    result = dict(count=len(values), meanMs=mean(values), medianMs=median(values), p95Ms=percentile(values, .95),
                  standardDeviationMs=stdev(values) if len(values) > 1 else None,
                  coefficientOfVariationPercent=100 * stdev(values) / mean(values) if len(values) > 1 else None,
                  sockets=dict(Counter(s['sockets'] for s in samples)), meanConfidence95Ms=None)
    if len(values) > 1:
        rng = np.random.default_rng(0)
        estimates = np.asarray(values)[rng.integers(0, len(values), size=(10000, len(values)))].mean(axis=1)
        result['meanConfidence95Ms'] = np.quantile(estimates, [.025, .975]).tolist()
    totals = [accounting_totals(s) for s in samples]
    result['phaseMeansMs'] = {phase: mean(t[phase] for t in totals) for phase in PHASES}
    if not math.isclose(sum(result['phaseMeansMs'].values()), result['meanMs'], abs_tol=1e-6):
        raise ValueError('Phase means do not cover the handler measurement')
    return result


def summarize(data):
    if data['failures']:
        raise ValueError('Cannot summarize a run with failures')
    samples = data['samples']
    if any(not s['verified'] or not s['cold'] for s in samples):
        raise ValueError('Every sample must be verified and cold')
    variants = data['configuration'].get('variants', VARIANTS)
    operations = {}
    for operation in ['read', 'write']:
        groups = {v: statistics([s for s in samples if s['variant'] == v and s['operation'] == operation]) for v in variants}
        if any(group['count'] != data['configuration']['count'] for group in groups.values()):
            raise ValueError('Sample count differs from the requested cohort')
        operations[operation] = groups
    writes = [s for s in samples if s['variant'] == 'no-plugin' and s['operation'] == 'write']
    landings = {}
    for name, sockets in [('oneConnection', 1), ('twoConnections', 2)]:
        group = statistics([s for s in writes if s['sockets'] == sockets])
        group['sharePercent'] = group['count'] / len(writes) * 100 if writes else 0
        landings[name] = group
    return dict(measuredAt=data.get('createdAt'), runtimes=sorted({s['nodeVersion'] for s in samples if 'nodeVersion' in s}),
                configuration={k: v for k, v in data['configuration'].items() if k != 'preparation'},
                operations=operations, writeLandings=landings)


def cohorts(summary, operation):
    groups = [(LABELS[v], v, g) for v, g in summary['operations'][operation].items()]
    if operation == 'write':
        index = next((i for i, (_, v, _) in enumerate(groups) if v == 'no-plugin'), len(groups))
        landings = [(('No plugin · 1 connection' if name == 'oneConnection' else 'No plugin · 2 connections'), 'no-plugin', g)
                    for name, g in summary['writeLandings'].items() if g['count']]
        groups[index + 1:index + 1] = landings
    return groups


def approx(value):
    return f'~{value:.0f}' if value >= 1 else f'~{value:.1f}'


def markdown(summary):
    configuration = summary['configuration']
    lines = [f"# {configuration.get('environment', 'Cold operation')} results", '',
             f"Measured {summary.get('measuredAt') or 'date not recorded'} · Node {', '.join(summary['runtimes']) or 'not recorded'}.", '',
             '| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |', '|---|---:|---:|---:|---:|---:|---:|']
    for operation in ['read', 'write']:
        for label, _, group in cohorts(summary, operation):
            ci = group.get('meanConfidence95Ms')
            values = [f'{group[k]:.1f}' if group.get(k) is not None else '—' for k in ['meanMs', 'medianMs', 'standardDeviationMs', 'p95Ms']]
            lines.append(f"| {operation} / {label} | {group['count']} | " + ' | '.join(values) + f" | {f'{ci[0]:.1f}–{ci[1]:.1f}' if ci else '—'} |")
    for operation in ['read', 'write']:
        groups = cohorts(summary, operation)
        lines += ['', f'### Average {operation} phase times', '',
                  '| Phase | ' + ' | '.join(f"{label} (n={g['count']})" for label, _, g in groups) + ' |', '|---|' + '---:|' * len(groups)]
        for phase, (label, _) in PHASES.items():
            lines.append(f'| {label} | ' + ' | '.join(f"{g['phaseMeansMs'][phase]:.1f}" for _, _, g in groups) + ' |')
            if phase == 'setup':
                for step, step_label in SETUP_STEPS.items():
                    cells = []
                    for _, variant, g in groups:
                        estimate = dict(setup_estimates(variant, g['phaseMeansMs']['setup'])).get(step)
                        cells.append(approx(estimate) if estimate is not None else '—')
                    if any(cell != '—' for cell in cells):
                        lines.append(f'| ↳ {step_label} | ' + ' | '.join(cells) + ' |')
        lines.append('| **Total** | ' + ' | '.join(f"**{g['meanMs']:.1f}**" for _, _, g in groups) + ' |')
    lines += ['', 'Durations are milliseconds from handler entry to the operation result. SSM retrieval during startup is excluded.',
              '', 'Every phase comes from driver events (`commandStarted`, `connectionReady`, `serverHeartbeat*`, `topologyOpening`, checkout events) and socket events (`lookup`, `connect`, `secureConnect`, first reply). Nothing in the driver is patched. Each millisecond is counted once, in the order the table lists phases; overlapping sockets are not added.',
              '', 'Setup has no events inside it. The ↳ rows marked ~ split the measured setup in proportions from an earlier run with code probes; SRV + TXT DNS applies only where the pattern resolves the SRV record.',
              '', 'Confidence intervals use 10,000 bootstrap resamples with a fixed seed and describe this run only.']
    checks = configuration.get('warmVerification', [])
    if checks:
        lines += ['', f'{len(checks)} warm checks verified client and socket reuse without another SSM request or discovery. They are excluded from the cold results.']
    for operation in ['read', 'write']:
        lines += ['', f'### {operation.title()} connection breakdowns', '']
        for label, slug in case_images(summary, operation):
            lines += [f'#### {label}', '', f'![{operation.title()} · {label}]({slug}.png)', '']
    lines.append('Each chart shows the sample nearest its cohort median. Sockets occupy separate overlapping rows; do not add their times.')
    return '\n'.join(lines) + '\n'


def case_images(summary, operation):
    images = []
    for variant, group in summary['operations'][operation].items():
        if operation == 'write' and variant == 'no-plugin':
            images += [(f"No plugin · {n} connection{'s' if n == 2 else ''}", f"write-no-plugin-{n}-connection{'s' if n == 2 else ''}")
                       for n, name in ((1, 'oneConnection'), (2, 'twoConnections')) if summary['writeLandings'][name]['count']]
        else:
            images.append((LABELS[variant], f'{operation}-{variant}'))
    return images


def member_rows(sample, members):
    """One row per replica-set member. The operation's row also carries checkout waits and other work."""
    trace = sample['trace']
    start = trace['start']
    selected = trace['command']['socket']
    rows = []
    for member in members:
        spans = []
        for socket in trace['sockets']:
            if socket['host'] != member:
                continue
            spans += [(phase if socket['kind'] == 'application' else 'monitor', socket[phase][0] - start, socket[phase][1] - start)
                      for phase in SOCKET_PHASES if phase in socket]
            spans += [('discovery', c['start'] - start, c['end'] - start) for c in trace['commands']
                      if c['name'] == 'replSetGetStatus' and c['socket'] and c['socket']['start'] == socket['start']]
        operation = selected['host'] == member
        segments = accounting_segments(sample)
        # Command preparation and checkout waits belong to the member they were for.
        spans += [(s['phase'], s['start'], s['end']) for s in segments if s['phase'] in ('prepare', 'checkout') and s.get('member') == member]
        if operation:
            spans.append(('operation', trace['command']['start'] - start, trace['command']['end'] - start))
            spans += [(s['phase'], s['start'], s['end']) for s in segments
                      if s['phase'] in ('routing', 'result', 'other') or (s['phase'] == 'checkout' and not s.get('member'))]
            setup_end = (setup_interval(sample) or (0, 0))[1]
            spans += [('waiting', left, right) for left, right in uncovered(spans, setup_end, sample['totalMs'])]
        rows.append({'member': member, 'spans': sorted(spans, key=lambda span: span[1]), 'operation': operation})
    return rows


def uncovered(spans, begin, end):
    """Gaps between `begin` and `end` that no span covers."""
    gaps = []
    cursor = begin
    for _, left, right in sorted(spans, key=lambda span: span[1]):
        if left > cursor:
            gaps.append((cursor, min(left, end)))
        cursor = max(cursor, right)
    if cursor < end:
        gaps.append((cursor, end))
    return [(left, right) for left, right in gaps if right > left]


def contacted_members(sample, members):
    """The members this sample opened a socket to, in the order it first contacted them."""
    first = {}
    for socket in sample['trace']['sockets']:
        first[socket['host']] = min(first.get(socket['host'], socket['start']), socket['start'])
    return sorted((member for member in members if member in first), key=lambda member: (first[member], members.index(member)))


def run_members(data):
    """Every member seen in the run, with the role it most often reported."""
    roles = {}
    for sample in data['samples']:
        for socket in sample['trace']['sockets']:
            roles.setdefault(socket['host'], Counter())[socket['role']] += 1
    return {host: counts.most_common(1)[0][0] for host, counts in sorted(roles.items())}


WAITING = ('Waiting on another member', '#e2e8f0')


def color(phase):
    if phase == 'waiting':
        return WAITING[1]
    return SETUP_SHADES[phase[6:]] if phase.startswith('setup:') else PHASES[phase][1]


def illustrated(data, operation):
    """One case per pattern, nearest its cohort median; no-plugin writes split by connection count."""
    cases = []
    for variant in data['configuration'].get('variants', VARIANTS):
        cohort = [s for s in data['samples'] if s['operation'] == operation and s['variant'] == variant]
        groups = [(LABELS[variant], variant, cohort)]
        if operation == 'write' and variant == 'no-plugin':
            groups = [(f"No plugin · {n} connection{'s' if n == 2 else ''}", f"no-plugin-{n}-connection{'s' if n == 2 else ''}",
                       [s for s in cohort if s['sockets'] == n]) for n in (1, 2)]
        for label, slug, group in groups:
            if group:
                middle = median(s['totalMs'] for s in group)
                cases.append(dict(label=label, variant=variant, slug=f'{operation}-{slug}', operation=operation,
                                  statistics=statistics(group), sample=min(group, key=lambda s: abs(s['totalMs'] - middle))))
    return cases


def render(data, summary, output_directory):
    output_directory.mkdir(parents=True, exist_ok=True)
    members = run_members(data)
    for operation in ['read', 'write']:
        for case in illustrated(data, operation):
            render_case(data, case, members, output_directory / f"{case['slug']}.png")


def render_case(data, case, members, output):
    sample, stats = case['sample'], case['statistics']
    trace = sample['trace']
    rows = member_rows(sample, contacted_members(sample, list(members)))
    ssm = [(('topologyStore' if c.get('command') == 'PutParameterCommand' else 'ssm'), c['start'] - trace['start'], c['end'] - trace['start'])
           for c in trace.get('ssm', [])]
    labels = [f"{row['member'].split('.')[0]} · {members[row['member']].capitalize()}" + (' · operation' if row['operation'] else '') for row in rows]
    if ssm:
        labels.insert(0, 'SSM')
    figure, axis = plt.subplots(figsize=(13, 1.0 + 0.6 * len(labels) + 2.6))
    visible = []

    def draw(y, phase, left, right, height=.5):
        if phase not in visible:
            visible.append(phase)
        estimated = phase.startswith('setup:')
        axis.barh(y, right - left, left=left, height=height, color=color(phase),
                  hatch='//' if estimated else None, edgecolor='white' if estimated else None, linewidth=0)

    top = len(labels)
    if ssm:
        for span in ssm:
            draw(top, *span)
    member_ys = [len(rows) - index for index in range(len(rows))]
    for y, row in zip(member_ys, rows):
        for span in row['spans']:
            draw(y, *span)
    setup_span = setup_interval(sample)
    if setup_span:
        # Setup happens before any member is contacted, so it spans every member row.
        left = setup_span[0]
        for step, duration in setup_estimates(sample['variant'], setup_span[1] - setup_span[0]):
            draw((min(member_ys) + max(member_ys)) / 2, 'setup:' + step, left, left + duration, height=len(rows) - .5)
            left += duration
    axis.set_yticks(list(reversed(range(1, top + 1))), labels, fontsize=9)
    for tick, row in zip(axis.get_yticklabels()[len(labels) - len(rows):], rows):
        if row['operation']:
            tick.set_fontweight('bold')
    axis.set_ylim(.4, top + .6)
    axis.set_xlim(0, sample['totalMs'] * 1.04)
    axis.set_xlabel('Milliseconds since handler entry', fontsize=9)
    axis.grid(axis='x', alpha=.15)
    axis.set_axisbelow(True)
    axis.spines[['top', 'right', 'left']].set_visible(False)

    setup = dict(setup_estimates(case['variant'], stats['phaseMeansMs']['setup']))
    setup_handles = [Patch(facecolor=color('setup:' + step), hatch='//', edgecolor='white', label=f'{SETUP_STEPS[step]} · {approx(setup[step])} ms')
                     for step in SETUP_STEPS if 'setup:' + step in visible]
    connection_handles = []
    for phase in [p for p in [*PHASES, 'waiting'] if p in visible]:
        if phase == 'waiting':
            connection_handles.append(Patch(facecolor=color(phase), label=WAITING[0]))
        else:
            connection_handles.append(Patch(facecolor=color(phase), label=f"{PHASES[phase][0]} · {stats['phaseMeansMs'][phase]:.1f} ms"))

    configuration = data['configuration']
    variation = f" · SD {stats['standardDeviationMs']:.1f} ms · CV {stats['coefficientOfVariationPercent']:.1f}%" if stats['count'] > 1 else ''
    environment = 'AWS' if 'AWS' in configuration.get('environment', '') else 'local'
    figure.suptitle(f"{case['operation'].title()} · {case['label']} · {configuration.get('environment', '')}",
                    x=.03, ha='left', y=1 - .15 / figure.get_figheight(), fontsize=15, weight='bold')
    figure.text(.03, 1 - .55 / figure.get_figheight(), f"Median {stats['medianMs']:.1f} ms · mean {stats['meanMs']:.1f} ms · p95 {stats['p95Ms']:.1f} ms{variation} · shown: the sample nearest the median ({sample['totalMs']:.1f} ms)\n"
                f"Measured {data.get('createdAt', '')[:10]} from a {stats['count']} cold start {environment} connection benchmark.",
                fontsize=9, color='#334155', va='top')
    legend_rows = max(len(setup_handles), math.ceil(len(connection_handles) / 2))
    height = figure.get_figheight()
    figure.subplots_adjust(left=.22, right=.97, top=1 - 1.15 / height, bottom=(1.0 + 0.2 * legend_rows) / height)

    # Each legend sits under the part of the chart it describes: Setup under the
    # setup bar, Connection from where setup ends, moved right only to avoid overlap.
    position = axis.get_position()
    below = position.y0 - .5 / height
    left = position.x0
    if setup_handles:
        setup_legend = figure.legend(handles=setup_handles, title='Setup', loc='upper left', bbox_to_anchor=(left, below),
                                     fontsize=8.5, title_fontsize=9, frameon=False, alignment='left')
        setup_legend.get_title().set_fontweight('bold')
        figure.canvas.draw()
        right = setup_legend.get_window_extent().transformed(figure.transFigure.inverted()).x1
        setup_end = (setup_span[1] if setup_span else 0) / axis.get_xlim()[1]
        left = max(position.x0 + setup_end * position.width, right + .015)
    connection_legend = figure.legend(handles=connection_handles, title='Connection', loc='upper left', bbox_to_anchor=(left, below),
                                      ncol=2, fontsize=8.5, title_fontsize=9, frameon=False, alignment='left')
    connection_legend.get_title().set_fontweight('bold')
    figure.savefig(output, dpi=130, facecolor='white', bbox_inches='tight', pad_inches=.25)
    plt.close(figure)


def load(path):
    """Reads samples from JSON, gzipped when the name ends in .gz."""
    return json.loads(gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_text())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('samples', type=Path)
    args = parser.parse_args()
    data = load(args.samples)
    summary = summarize(data)
    render(data, summary, args.samples.parent)
    args.samples.with_name('summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    args.samples.with_name('results.md').write_text(markdown(summary))
    print(markdown(summary))
