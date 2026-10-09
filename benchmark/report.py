#!/usr/bin/env python3
"""Refresh benchmark images and data without modifying Markdown."""
import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean, median

PHASES = {
    'tcp': 'TCP / DNS', 'tls': 'TLS', 'hello': 'Hello + speculative auth',
    'auth': 'Remaining auth', 'send': 'Send / buffer',
    'receive': 'Receive / wait', 'other': 'Other / discovery',
}
VARIANTS = {'native': 'MongoClient', 'serverless': 'ServerlessMongoClient'}
TIMELINE_PHASES = {
    'setup': 'Before monitoring', 'monitor': '1. Monitoring connection',
    'selection': 'Between connections', 'application': '2. Application connection',
    'dispatch': 'Before command', 'send': 'Send / buffer',
    'receive': 'Receive / wait', 'completion': 'Return to caller',
}


def connection_timeline(sample):
    trace = sample['trace']
    command = trace['command']
    application = command['socket']
    monitors = [socket for socket in trace['sockets']
                if (socket['host'], socket['port']) == (application['host'], application['port'])
                and socket['start'] < application['start']
                and 'hello' in socket and socket['hello'][1] <= application['start']]
    if len(monitors) != 1:
        raise ValueError('Expected one completed monitor connection to the application host')
    monitor = monitors[0]
    boundaries = [trace['start'], monitor['start'], monitor['hello'][1],
                  application['start'], application['auth'][1], command['start'],
                  command['sent'], command['end'], trace['end']]
    if any(not math.isfinite(value) for value in boundaries) or any(
            end < start for start, end in zip(boundaries, boundaries[1:])):
        raise ValueError('Invalid or overlapping connection timing intervals')
    phases = dict(zip(TIMELINE_PHASES, [end - start for start, end in zip(boundaries, boundaries[1:])]))

    def connection(socket, names):
        end = socket[names[-1]][1]
        cursor = socket['start']
        details = {}
        for name in names:
            begin, finish = socket[name]
            if not all(math.isfinite(value) for value in (begin, finish)) or not cursor <= begin <= finish:
                raise ValueError('Invalid or overlapping socket timing intervals')
            details[name] = finish - begin
            cursor = finish
        duration = end - socket['start']
        details['gaps'] = duration - sum(details.values())
        return {'host': socket['host'], 'start': socket['start'] - trace['start'],
                'end': end - trace['start'], 'duration': duration, 'phases': details,
                'intervals': {name: [value - trace['start'] for value in socket[name]] for name in names}}

    return {'phases': phases, 'monitor': connection(monitor, ['tcp', 'tls', 'hello']),
            'application': connection(application, ['tcp', 'tls', 'hello', 'auth']),
            'parallel_monitors': [connection(socket, ['tcp', 'tls', 'hello'])
                                  for socket in trace['sockets']
                                  if (socket['host'], socket['port']) != (application['host'], application['port'])]}


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


def save_plot(fig, path):
    import matplotlib.pyplot as plt

    for extension in ('png', 'svg'):
        destination = path.with_suffix('.' + extension)
        fig.savefig(destination, dpi=180, facecolor=fig.get_facecolor())
        if extension == 'svg':
            destination.write_text('\n'.join(line.rstrip() for line in destination.read_text().splitlines()) + '\n')
    plt.close(fig)


def plot_timeline(groups, summaries, asset_dir, count, seed_order=None):
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch, Rectangle

    colors = {'tcp': '#2563eb', 'tls': '#38bdf8', 'hello': '#a78bfa',
              'auth': '#f59e0b', 'send': '#ef4444', 'receive': '#10b981', 'gaps': '#cbd5e1'}
    labels = {'tcp': 'TCP / DNS', 'tls': 'TLS', 'hello': 'Hello',
              'auth': 'Remaining auth', 'send': 'Send / buffer',
              'receive': 'Receive / wait', 'gaps': 'Setup / gaps / return'}
    display_host = lambda host: 'member ' + host.split('-shard-')[1].split('.')[0] if '-shard-' in host else host
    fig, axes = plt.subplots(1, 2, figsize=(18, 9), sharex=True)
    fig.patch.set_facecolor('#f8fafc')
    parallel_ends = [mean(m['end'] for t in group for m in t['parallel_monitors'] if m['host'] == host)
                     for group in groups.values()
                     for host in {m['host'] for t in group for m in t['parallel_monitors']}]
    limit = max(max(summary['mean'] for summary in summaries.values()),
                max(parallel_ends, default=0)) * 1.12
    for ax, operation in zip(axes, ('read', 'write')):
        ax.set_facecolor('#f8fafc')
        ax.spines[['top', 'right', 'left']].set_visible(False)
        ax.set_axisbelow(True)
        ax.grid(axis='x', alpha=.18)
        ax.set_title(operation.title(), loc='center', fontweight='bold', fontsize=15)
        ax.set_xlim(0, limit)
        row = 0
        ticks, tick_labels = [], []
        ax.set_xlabel('Milliseconds since client construction (mean)')
        for variant in VARIANTS:
            key = (variant, operation)
            group = groups[key]
            ticks.append(row)
            tick_labels.append(VARIANTS[variant] + '\n' + display_host(group[0]['monitor']['host']) + ' (selected)')
            total = summaries[key]['mean']
            ax.barh(row, total, color=colors['gaps'], height=.30)
            setup = mean(t['phases']['setup'] for t in group)
            ax.text(setup / 2, row, f'{setup:.1f}', ha='center', va='center', fontsize=9)
            for number, connection in enumerate(('monitor', 'application'), 1):
                start = mean(t[connection]['start'] for t in group)
                end = mean(t[connection]['end'] for t in group)
                for phase in group[0][connection]['intervals']:
                    begin = mean(t[connection]['intervals'][phase][0] for t in group)
                    finish = mean(t[connection]['intervals'][phase][1] for t in group)
                    ax.barh(row, finish - begin, left=begin, color=colors[phase],
                            height=.30, label=labels[phase])
                    ax.patches[-1].set_label(labels[phase])
                    if finish - begin >= 2:
                        ax.text((begin + finish) / 2, row, f'{finish - begin:.1f}',
                                ha='center', va='center', fontsize=9,
                                color='white' if phase == 'tcp' else '#0f172a')
                ax.add_patch(Rectangle((start, row - .15), end - start, .30,
                                      fill=False, edgecolor='#334155', linewidth=1.2))
                ax.plot([start, start, end, end], [row - .23, row - .29, row - .29, row - .23],
                        color='#334155', linewidth=1)
                name = 'Monitoring' if connection == 'monitor' else 'Application'
                ax.text((start + end) / 2, row - .34, f'{number} · {name}\n{end - start:.1f} ms',
                        ha='center', va='bottom', fontsize=10, fontweight='bold', color='#0f172a')
            primary_known = mean(t['monitor']['end'] for t in group)
            application_start = mean(t['application']['start'] for t in group)
            ax.plot([primary_known, primary_known], [row - .16, row + .24],
                    color='#0f172a', linewidth=1, linestyle=':')
            ax.annotate('Primary confirmed' if variant == 'native' else 'Selected host responds', xy=(primary_known, row + .24),
                        xytext=(primary_known, row + .36), ha='center', va='center',
                        fontsize=9, color='#0f172a')
            ax.annotate('', xy=(application_start, row - .20), xytext=(primary_known, row - .20),
                        arrowprops={'arrowstyle': '->', 'color': '#0f172a', 'lw': 1.2})
            command_start = mean(t['application']['end'] + t['phases']['dispatch'] for t in group)
            for phase in ('send', 'receive'):
                duration = mean(t['phases'][phase] for t in group)
                ax.barh(row, duration, left=command_start, color=colors[phase], height=.30)
                if duration >= 2:
                    ax.text(command_start + duration / 2, row, f'{duration:.1f}', ha='center', va='center', fontsize=9)
                command_start += duration
            ax.text(total + .5, row, f'{total:.1f}', va='center', fontweight='bold', fontsize=10)
            hosts = sorted({m['host'] for t in group for m in t['parallel_monitors']})
            for index, host in enumerate(hosts, 1):
                lane = row + .22 + index * .55
                ticks.append(lane)
                tick_labels.append(f'{display_host(host)} monitor')
                connections = [m for t in group for m in t['parallel_monitors'] if m['host'] == host]
                if len(connections) != len(group):
                    raise ValueError(f'Expected one completed parallel monitor per sample for {host}')
                begin = mean(m['start'] for m in connections)
                finish = mean(m['end'] for m in connections)
                ax.barh(lane, finish - begin, left=begin, color=colors['gaps'], height=.23)
                for phase in ('tcp', 'tls', 'hello'):
                    start = mean(m['intervals'][phase][0] for m in connections)
                    end = mean(m['intervals'][phase][1] for m in connections)
                    ax.barh(lane, end - start, left=start, color=colors[phase], height=.23)
                    ax.patches[-1].set_gid(f'parallel:{host}:{phase}')
                ax.text(finish + .5, lane, f'{finish - begin:.1f} ms · concurrent',
                        va='center', fontsize=9, color='#475569')
            if not hosts:
                ax.text(0, row + .65, 'Direct connection: no monitoring connections to other members',
                        va='center', fontsize=10, color='#475569')
            row += 1.60 + max(len(hosts) - 1, 0) * .55
        ax.set_ylim(row - .35, -.70)
        ax.set_yticks(ticks, tick_labels)

    axes[1].tick_params(labelleft=False)
    fig.suptitle('Cold MongoDB connections · sequential setup and parallel monitors',
                 fontsize=19, fontweight='bold', x=.035, ha='left')
    fig.text(.035, .905, 'Native client: primary hello confirms role → primary selected → application connection opens. No need to wait for secondary replies.',
             fontsize=12, color='#334155')
    seed_note = 'native: six seed orders; serverless: one selected host' if seed_order == 'cycle-six-permutations' else seed_order or 'historical fixed seed order'
    fig.text(.035, .855, f'Means from {count} fresh processes per case · {seed_note} · shared elapsed-time scale',
             fontsize=11, color='#475569')
    fig.legend(handles=[Patch(color=colors[key], label=label) for key, label in labels.items()],
               loc='lower center', ncol=4, frameon=False, bbox_to_anchor=(.5, .05))
    fig.text(.035, .02, 'Bars end at the initial hello / authentication, not socket closure. Parallel monitor durations are not added to the operation total.',
             fontsize=10, color='#475569')
    fig.subplots_adjust(left=.13, right=.975, top=.77, bottom=.19, wspace=.10)
    save_plot(fig, asset_dir / 'latency')


def plot_samples(summaries, keys, asset_dir, count):
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(10, 6))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    for index, key in enumerate(keys):
        values = summaries[key]['totals']
        xs = [index + ((i * .61803398875) % 1 - .5) * .28 for i in range(len(values))]
        ax.scatter(xs, values, alpha=.4, s=22, color='#2563eb' if key[0] == 'native' else '#0d9488')
        ax.plot([index - .22, index + .22], [summaries[key]['median']] * 2, color='#0f172a', linewidth=2.5)
        ax.annotate(f"p50 {summaries[key]['median']:.1f}", (index, summaries[key]['median']),
                    xytext=(0, 12), textcoords='offset points', ha='center', fontsize=10)
    ax.set_xticks(range(4), ['MongoClient\nRead', 'Serverless\nRead', 'MongoClient\nWrite', 'Serverless\nWrite'])
    ax.set_ylim(0, max(summaries[key]['max'] for key in keys) * 1.2)
    ax.set_ylabel('Milliseconds from client construction to completed operation')
    ax.set_title(f'Every cold connection sample · {count} per case · line = median', fontweight='bold')
    ax.grid(axis='y', alpha=.18)
    ax.set_axisbelow(True)
    ax.spines[['top', 'right']].set_visible(False)
    fig.tight_layout(pad=2)
    save_plot(fig, asset_dir / 'samples')


def plot_table(title, columns, rows, path, note=''):
    import matplotlib.pyplot as plt
    from textwrap import fill

    width = 16 if len(columns) > 7 else 14
    first_width = .30 if len(columns) > 2 else .20
    widths = [first_width] + [(1 - first_width) / (len(columns) - 1)] * (len(columns) - 1)
    wrap = lambda value, index: fill(str(value), max(10, int(widths[index] * width * 10)))
    cells = [[wrap(value, index) for index, value in enumerate(row)] for row in rows]
    heights = [max(cell.count('\n') + 1 for cell in row) for row in cells]
    fig, ax = plt.subplots(figsize=(width, 1.6 + sum(.32 * height + .14 for height in heights)))
    fig.patch.set_facecolor('#f8fafc')
    ax.axis('off')
    table = ax.table(cellText=cells, colLabels=[wrap(value, i) for i, value in enumerate(columns)],
                     colWidths=widths, cellLoc='left', bbox=[0, 0, 1, .82])
    table.auto_set_font_size(False)
    table.set_fontsize(10)
    for (row, col), cell in table.get_celld().items():
        cell.set_edgecolor('#dbe3ed')
        cell.set_facecolor('#e2e8f0' if row == 0 else '#ffffff' if row % 2 else '#f1f5f9')
        if row == 0:
            cell.set_text_props(weight='bold')
        else:
            cell.set_height(cell.get_height() * heights[row - 1])
    fig.text(.025, .94, title, fontsize=17, fontweight='bold', va='top')
    fig.text(.025, .83, note, fontsize=10, va='top', color='#475569')
    fig.subplots_adjust(left=.025, right=.975, top=.88, bottom=.04)
    save_plot(fig, path)


def plot_measurements(data, summaries, groups, timeline_means, keys, asset_dir):
    label = lambda key: f'{VARIANTS[key[0]]} / {key[1]}'
    numbers = lambda values: [f'{value:.2f}' for value in values]
    rows = []
    for key in keys:
        s = summaries[key]
        rows.append([label(key), *numbers([s['median'], s['p95'], s['mean']]), f"{s['min']:.2f}–{s['max']:.2f}"])
    differences = []
    for operation in ('read', 'write'):
        native = summaries[('native', operation)]['median']
        wrapper = summaries[('serverless', operation)]['median']
        differences.append(f'{operation}: {wrapper-native:+.2f} ms ({(wrapper/native-1)*100:+.1f}%)')
    plot_table('Operation latency (milliseconds)', ['Client / operation', 'Median', 'p95', 'Mean', 'Range'],
               rows, asset_dir / 'results',
               f"Measured {data['createdAt']} · {len(data['samples'])} samples\nMedian difference, wrapper minus native: " + ' · '.join(differences))
    rows = []
    for key in keys:
        values = [mean(t[c][field] for t in groups[key]) for c in ('monitor', 'application')
                  for field in ('start', 'end', 'duration')]
        rows.append([label(key), *numbers(values)])
    plot_table('Connection start and ready times',
               ['Client / operation', '1: start', '1: hello complete', '1: duration', '2: start', '2: authenticated', '2: duration'],
               rows, asset_dir / 'connection-times', 'Means in milliseconds since client construction; durations measure setup, not socket lifetime.')
    rows = []
    for key in keys:
        p = timeline_means[key]
        gaps = mean(t['application']['phases']['gaps'] for t in groups[key]) + p['dispatch'] + p['completion']
        rows.append([label(key), *numbers([p['setup'], p['monitor'], p['selection'], gaps, summaries[key]['phases']['other']])])
    plot_table('Where the former Other / discovery time went',
               ['Client / operation', 'Before monitoring', 'Monitoring connection', 'Between connections', 'Other gaps', 'Former Other'],
               rows, asset_dir / 'other-times', 'Mean milliseconds; monitoring and gaps were previously grouped together.')
    ordered = defaultdict(list)
    for sample in data['samples']:
        if sample['variant'] == 'native' and 'seedOrder' in sample:
            ordered[(tuple(sample['seedOrder']), sample['operation'])].append(sample['timings']['total'])
    rows = [[' → '.join(host.split(':')[0] for host in order), operation, len(totals), f'{mean(totals):.2f}']
            for (order, operation), totals in sorted(ordered.items())]
    plot_table('Native client by seed order', ['Seed order', 'Operation', 'Samples', 'Mean total (ms)'],
               rows or [['Not recorded', '—', '—', '—']], asset_dir / 'seed-orders',
               'Serverless uses one selected host and has no seed-order treatment.')
    rows = []
    for key in keys:
        for connection in ('monitor', 'application'):
            values = numbers([mean(t[connection]['phases'].get(phase, 0) for t in groups[key])
                              for phase in ('tcp', 'tls', 'hello', 'auth', 'gaps')])
            if connection == 'monitor':
                values[3] = '—'
            rows.append([label(key), connection, *values, f"{mean(t[connection]['duration'] for t in groups[key]):.2f}"])
    plot_table('Mean connection phases (milliseconds)',
               ['Client / operation', 'Connection', 'TCP / DNS', 'TLS', 'Hello', 'Auth', 'Gaps', 'Total'],
               rows, asset_dir / 'connection-phases', 'These phases are inside the connection intervals, not additional elapsed time.')
    plot_table('Mean timeline segments (milliseconds)', ['Client / operation', *TIMELINE_PHASES.values()],
               [[label(key), *numbers(timeline_means[key][phase] for phase in TIMELINE_PHASES)] for key in keys],
               asset_dir / 'timeline-segments', 'Sequential segments sum to mean total elapsed time.')
    env, first, config = data['environment'], data['samples'][0], data['configuration']
    if env.get('kind') == 'aws-lambda':
        plot_table('AWS network and environment', ['Setting', 'Value'], [
            ['Measured', data['createdAt']], ['Samples', f"{len(data['samples'])} total"],
            ['Region', env['region']], ['Lambda', f"{env['architecture']} / {env['memoryMB']} MB"],
            ['Node / driver', f"{first['nodeVersion']} / {first['driverVersion']}"],
            ['MongoDB', env['mongo']], ['Network', env['network']],
            ['Timer', config['timer']], ['Seed ordering', config['seedOrder']],
        ], asset_dir / 'environment', 'AWS initialization evidence remains in samples.json; connection timings exclude it.')
        return
    plot_table('Network latency (milliseconds)', ['Source', 'Destination', 'Injected RTT', 'Measured ping mean'],
               [[n['source'], n['target'], *numbers([n['configuredRttMs'], n['measuredRttMs']])] for n in data['network']],
               asset_dir / 'network', 'Injected delay is split between directions. Measured RTT includes Docker overhead.')
    env, first, config = data['environment'], data['samples'][0], data['configuration']
    plot_table('Run and environment', ['Setting', 'Value'], [
        ['Measured', data['createdAt']], ['Samples', f"{config['count']} per client / operation; {len(data['samples'])} total"],
        ['Harness commit', env['git'] + (' (local changes)' if env.get('gitDirty') else '')],
        ['Seed ordering', config.get('seedOrder', 'Historical fixed order')],
        ['Node / driver', f"{first['nodeVersion']} / {first['driverVersion']}"],
        ['MongoDB', env['mongo'].splitlines()[0]], ['Docker', json.loads(env['docker'])['Version']],
        ['Client kernel', env['client']],
    ], asset_dir / 'environment', 'Image identities and complete metadata are retained in samples.json.')


def render(data, asset_dir):
    import matplotlib
    matplotlib.use('Agg')

    summaries = summarize(data['samples'])
    keys = [(variant, operation) for operation in ['read', 'write'] for variant in VARIANTS]
    recovered = [connection_timeline(sample) for sample in data['samples']]
    groups = defaultdict(list)
    for sample, timeline in zip(data['samples'], recovered):
        groups[(sample['variant'], sample['operation'])].append(timeline)
    timeline_means = {key: {phase: mean(t['phases'][phase] for t in group)
                            for phase in TIMELINE_PHASES} for key, group in groups.items()}
    config = data['configuration']
    asset_dir.mkdir(parents=True, exist_ok=True)
    plot_measurements(data, summaries, groups, timeline_means, keys, asset_dir)
    plot_samples(summaries, keys, asset_dir, config['count'])
    plot_timeline(groups, summaries, asset_dir, config['count'], config.get('seedOrder'))
    (asset_dir / 'samples.json').write_text(json.dumps(data, indent=2) + '\n')
    (asset_dir / 'connection-timings.json').write_text(json.dumps([
        {'variant': sample['variant'], 'operation': sample['operation'],
         'iteration': sample.get('iteration'), 'timeline': timeline}
        for sample, timeline in zip(data['samples'], recovered)], indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('samples', type=Path)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent / 'baseline')
    args = parser.parse_args()
    render(json.loads(args.samples.read_text()), args.output_dir.resolve())
