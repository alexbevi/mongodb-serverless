"""Plot recorded Lambda INIT plus one unrestricted read, with socket-owned lanes."""
import argparse
import hashlib
import importlib.util
import json
import math
import zipfile
from pathlib import Path
from statistics import median

spec = importlib.util.spec_from_file_location('lambda_report', Path(__file__).with_name('lambda-report.py'))
lambda_report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lambda_report)
breakdown = lambda_report.breakdown
plt = breakdown.plt

NAMES = {'native': 'Standard MongoDB', 'no-plugin': 'Serverless · no plugin', 'ssm': 'Serverless · cached topology'}
COLORS = {**breakdown.COLORS, 'init': '#172554', 'mongo': '#38bdf8', 'topology': '#b45309',
          'read': '#10b981', 'code': '#94a3b8', 'callback': '#cbd5e1', 'dispatch': '#e2e8f0', 'other': '#94a3b8'}


def read_case(samples, encoding=None):
    if not samples or any(sample.get('lambda', {}).get('initMs') is None for sample in samples):
        raise ValueError('Every read needs a recorded Lambda INIT duration')
    if any(sample['operation'] != 'read' or not sample['verified'] or not sample['cold'] for sample in samples):
        raise ValueError('Use verified cold reads only')
    totals = [sample['lambda']['initMs'] + sample['totalMs'] for sample in samples]
    middle = median(totals)
    sample = min(samples, key=lambda item: abs(item['lambda']['initMs'] + item['totalMs'] - middle))
    if encoding:
        lambda_report.codec.expand_diagnostics(dict(samples=[sample], diagnosticEncoding=encoding))
    trace = sample['trace']
    measured = lambda_report.timeline(sample)
    start = trace['start']
    init = sample['lambda']['initMs']
    spans = breakdown.accounting_segments(measured)
    accounting = lambda_report.cold_accounting(sample)
    lanes = lambda_report.handler_lanes(sample)
    for lane in lanes:
        for span in lane['spans']:
            if span['phase'].startswith('code:'):
                span['phase'] = 'code'
    return dict(variant=sample['variant'], iteration=sample['iteration'], count=len(samples), medianMs=middle,
                p95Ms=lambda_report.percentile(totals, .95), totalMs=init+sample['totalMs'],
                initMs=init, handlerMs=sample['totalMs'], accountingMs=accounting,
                segments=spans, lanes=lanes)


def package_info(path, expected_hash):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_hash:
        raise ValueError('The ZIP does not match the package hash recorded with these samples')
    with zipfile.ZipFile(path) as archive:
        unpacked = sum(item.file_size for item in archive.infolist())
    return dict(zipBytes=path.stat().st_size, unpackedBytes=unpacked, sha256=digest)


def overview_phase(phase):
    if phase in ['lookup', 'tcp', 'tls', 'hello', 'auth', 'monitor']:
        return 'mongo'
    if phase in ['discovery', 'roleCheck']:
        return 'topology'
    if phase in ['send', 'receive']:
        return 'read'
    if phase.startswith('code:'):
        return 'code'
    return phase


def merged(spans):
    result = []
    for span in spans:
        if result and result[-1]['phase'] == span['phase'] and (span['start'] <= result[-1]['end'] or math.isclose(result[-1]['end'], span['start'])):
            result[-1]['end'] = max(result[-1]['end'], span['end'])
        else:
            result.append(dict(span))
    return result


def style_axis(axis, maximum):
    axis.set_xlim(0, maximum)
    axis.grid(axis='x', color='#e2e8f0', linewidth=.7)
    axis.set_axisbelow(True)
    axis.spines[['top', 'right', 'left']].set_visible(False)
    axis.spines['bottom'].set_color('#94a3b8')
    axis.tick_params(axis='both', length=0, labelsize=11)


def render_overview(cases, package, configuration, date, path):
    figure = plt.figure(figsize=(15, 12.5), facecolor='white')
    figure.text(.055, .961, 'Cold Lambda → one read', fontsize=25, weight='bold', color='#0f172a')
    figure.text(.055, .928, f'AWS {configuration["region"]} · Node 24 · {configuration["memoryMB"]} MB · arm64 · measured {date[:10]}\nRead preference: nearest (primary or secondary) · {cases[0]["count"]} fresh environments per case', fontsize=12, linespacing=1.6)
    figure.text(.055, .868, f'PACKAGE   {package["zipBytes"]/1e6:.2f} MB ZIP  /  {package["unpackedBytes"]/1e6:.2f} MB unpacked  ·  identical bundle for all cases', fontsize=12, weight='bold', color='#172554')
    axis = figure.add_axes([.275, .653, .66, .17])
    maximum = math.ceil(max(case['totalMs'] for case in cases) / 100) * 100 + 30
    for index, case in enumerate(cases):
        y = 2-index
        spans = [dict(phase='init', start=0, end=case['initMs'])]
        spans += [dict(phase=overview_phase(span['phase']), start=span['start']+case['initMs'], end=span['end']+case['initMs']) for span in case['segments']]
        for span in merged(spans):
            axis.barh(y, span['end']-span['start'], left=span['start'], height=.38, color=COLORS[span['phase']], linewidth=0)
            if span['phase'] == 'init':
                axis.text((span['start']+span['end'])/2, y, f'INIT  {case["initMs"]:.1f} ms · includes SSM', color='white', ha='center', va='center', fontsize=11, weight='bold')
        axis.text(-20, y+.06, NAMES[case['variant']], ha='right', va='center', fontsize=12, weight='bold')
        axis.text(-20, y-.22, f'Median {case["medianMs"]:.1f} ms · p95 {case["p95Ms"]:.1f} ms', ha='right', va='center', fontsize=10, color='#475569')
        axis.text(case['totalMs']+6, y, f'{case["totalMs"]:.1f}', va='center', fontsize=11, weight='bold')
    style_axis(axis, maximum)
    axis.set_ylim(-.55, 2.55)
    axis.set_yticks([])
    axis.set_xlabel('Milliseconds · recorded INIT + measured handler time through read result', fontsize=11, labelpad=10)
    legend = [('init', 'Lambda INIT · includes SSM'), ('clusterDns', 'SRV / TXT'), ('mongo', 'MongoDB handshakes'),
              ('topology', 'Role / topology checks'), ('read', 'Read exchange'), ('code', 'Driver / runtime code'), ('callback', 'Callbacks'), ('dispatch', 'Dispatch / wait'), ('other', 'Other handler work / scheduling')]
    figure.legend(handles=[breakdown.Patch(facecolor=COLORS[key], label=label) for key, label in legend],
                  loc='upper center', bbox_to_anchor=(.5, .617), ncol=5, fontsize=10, frameon=False)
    figure.text(.055, .548, 'Full wall-time breakdown of the three illustrated invocations', fontsize=15, weight='bold')
    figure.text(.055, .526, 'One real invocation nearest each cohort median. Every measured millisecond is allocated once; values are rounded.', fontsize=10, color='#475569')
    rows = [('init', 'Lambda INIT · excluding the SSM request'), ('ssm', 'SSM · SecureString fetch and decryption'),
            ('clusterDns', 'Cluster DNS · SRV + TXT'), ('monitor', 'Monitor handshakes · overlapping time counted once'),
            ('lookup', 'Application connection · host DNS'), ('tcp', 'Application connection · TCP'), ('tls', 'Application connection · TLS'),
            ('hello', 'Application connection · initial hello'), ('auth', 'Application connection · authentication'),
            ('roleCheck', 'Role validation · hello'), ('discovery', 'Topology discovery · replSetGetStatus'),
            ('send', 'Read · command start to socket write'), ('receive', 'Read · socket write to reply'),
            ('code', 'Other measured driver / runtime code'), ('callback', 'Other callbacks / continuations'), ('dispatch', 'Other dispatch / wait'), ('other', 'Other handler work / scheduling')]
    values = []
    for phase, label in rows:
        times = [sum(value for key, value in case['accountingMs'].items() if key.startswith('code:')) if phase == 'code' else case['accountingMs'].get(phase, 0) for case in cases]
        values.append([label, *[f'{value:.1f}' if value else '—' for value in times]])
    values.append(['TOTAL · INIT through read result', *[f'{case["totalMs"]:.1f}' for case in cases]])
    table_axis = figure.add_axes([.055, .137, .88, .367])
    table_axis.axis('off')
    table = table_axis.table(cellText=values, colLabels=['Milliseconds', 'Standard', 'No plugin', 'Cached topology'],
                            colWidths=[.55, .15, .15, .15], loc='center', cellLoc='right', bbox=[0, 0, 1, 1])
    table.auto_set_font_size(False)
    table.set_fontsize(10.5)
    for (row, column), cell in table.get_celld().items():
        cell.set_linewidth(.4)
        cell.set_edgecolor('#e2e8f0')
        if column == 0:
            cell.set_text_props(ha='left')
        if row == 0 or row == len(values):
            cell.set_facecolor('#eff6ff')
            cell.set_text_props(weight='bold')
        elif row % 2 == 0:
            cell.set_facecolor('#f8fafc')
    figure.text(.055, .101, 'Timing boundary: reported INIT + handler measurement → read result. SSM is included in INIT; the remaining INIT time has no internal phase split.', fontsize=10)
    figure.text(.055, .080, 'Provisioning, caller transport and post-result reporting are outside this view. Clients stay open for warm calls.', fontsize=10)
    figure.text(.055, .059, 'The package contains both drivers and diagnostic probes; these are instrumented measurements, not minimal production bundles.', fontsize=10)
    figure.text(.055, .038, 'Connection details show the same invocations. Tiny intervals are rounded here; exact durations are retained in cold-start.json.', fontsize=10, color='#475569')
    figure.savefig(path, dpi=160, facecolor='white')
    plt.close(figure)


def render_connections(cases, path):
    heights = [len(case['lanes'])+2.5 for case in cases]
    figure, axes = plt.subplots(len(cases), 1, figsize=(15, 13), gridspec_kw=dict(height_ratios=heights))
    maximum = math.ceil(max(case['handlerMs'] for case in cases)/50)*50
    for axis, case in zip(axes, cases):
        lanes = case['lanes']
        for index, lane in enumerate(lanes):
            y = len(lanes)-index-1
            spans = merged(sorted(lane['spans'], key=lambda span: span['start'])) if lane['kind'] in ['code', 'dns'] else lane['spans']
            for span in spans:
                width = span['end']-span['start']
                phase = span['phase']
                axis.barh(y, width, left=span['start'], height=.38, color=COLORS[phase], linewidth=0)
                if width >= 18 and lane['kind'] != 'code':
                    axis.text((span['start']+span['end'])/2, y, f'{width:.1f}', ha='center', va='center', fontsize=10,
                              color='white' if phase in ['ssm', 'clusterDns', 'lookup', 'tcp', 'discovery', 'roleCheck'] else '#0f172a')
        axis.set_yticks(list(reversed(range(len(lanes)))), [lane['label'] for lane in lanes], fontsize=10.5)
        axis.set_ylim(-.8, len(lanes)+.1)
        style_axis(axis, maximum)
        sockets = sum(lane['kind'] == 'connection' for lane in lanes)
        axis.set_title(f'{NAMES[case["variant"]]} · {sockets} MongoDB connection' + ('s' if sockets != 1 else '') +
                       f'\nINIT {case["initMs"]:.1f} ms  +  handler to read {case["handlerMs"]:.1f} ms  =  {case["totalMs"]:.1f} ms',
                       loc='left', fontsize=13, weight='bold', pad=12)
        axis.set_xlabel('Milliseconds since handler measurement started · INIT (including SSM) is outside this zoom', fontsize=10.5)
    figure.suptitle('What happens after Lambda INIT', x=.06, ha='left', fontsize=24, weight='bold', y=.976)
    figure.text(.06, .939, 'SSM completes during INIT. Each MongoDB row shows only activity on that socket. Reads permit either healthy role.', fontsize=11)
    legend = [(key, breakdown.phase_label(key).removeprefix('Application ')) for key in
              ['ssm', 'clusterDns', 'lookup', 'tcp', 'tls', 'hello', 'auth', 'roleCheck', 'discovery', 'send', 'receive']]
    legend += [('code', 'Other measured code'), ('callback', 'Other callbacks'), ('dispatch', 'Other dispatch / wait'), ('other', 'Other handler work / scheduling')]
    figure.legend(handles=[breakdown.Patch(facecolor=COLORS[key], label=label) for key, label in legend],
                  loc='lower center', bbox_to_anchor=(.51, .035), ncol=4, fontsize=9.5, frameon=False)
    figure.text(.06, .018, 'Blank socket intervals mean no measured exchange. Bars show activity, not socket lifetime. Overlapping rows must not be summed.', fontsize=10, color='#475569')
    figure.subplots_adjust(left=.29, right=.95, top=.88, bottom=.16, hspace=.75)
    figure.savefig(path, dpi=160, facecolor='white')
    plt.close(figure)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('samples', type=Path)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.samples.read_text())
    if data['failures']:
        raise ValueError('Refusing a measurement run with failures')
    package = package_info(args.package, data['configuration']['packageSha256'])
    cases = []
    for variant in NAMES:
        samples = [sample for sample in data['samples'] if sample['operation'] == 'read' and sample['variant'] == variant]
        if len(samples) != data['configuration']['count']:
            raise ValueError('Read cohort does not match the recorded sample count')
        cases.append(read_case(samples, data.get('diagnosticEncoding')))
    args.output.mkdir(parents=True, exist_ok=True)
    render_overview(cases, package, data['configuration'], data['createdAt'], args.output/'cold-start.png')
    render_connections(cases, args.output/'connection-details.png')
    (args.output/'cold-start.json').write_text(json.dumps(dict(measuredAt=data['createdAt'], package=package, cases=cases), indent=2)+'\n')
    print(json.dumps(dict(package=package, cases=[{key: case[key] for key in ['variant', 'medianMs', 'p95Ms', 'totalMs', 'initMs', 'handlerMs']} for case in cases]), indent=2))


if __name__ == '__main__':
    main()
