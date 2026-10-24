"""Require the cached-topology plugin to cut median cold latency by 10% for reads and writes."""
import json
import math
import sys
from pathlib import Path
from statistics import median

REQUIRED_REDUCTION = 0.10


def cohort(data, operation, variant):
    count = data['configuration']['count']
    samples = [s for s in data['samples'] if s['operation'] == operation and s['variant'] == variant]
    if len(samples) != count or {s['iteration'] for s in samples} != set(range(count)):
        raise ValueError(f'{operation}/{variant}: expected exactly {count} distinct iterations')
    if not all(s['verified'] is True for s in samples):
        raise ValueError(f'{operation}/{variant}: operation verification failed')
    durations = [s['totalMs'] for s in samples]
    if not all(math.isfinite(value) and value > 0 for value in durations):
        raise ValueError(f'{operation}/{variant}: invalid latency')
    return median(durations)


def check_performance(data):
    if data.get('failures'):
        raise ValueError('The benchmark run recorded failures')
    for operation in ('read', 'write'):
        for variant in data['configuration']['variants']:
            cohort(data, operation, variant)
    rows = []
    for operation in ('read', 'write'):
        native = cohort(data, operation, 'native')
        no_plugin = cohort(data, operation, 'no-plugin')
        cached = cohort(data, operation, 'ssm')
        rows.append({'operation': operation, 'nativeMedianMs': native, 'noPluginMedianMs': no_plugin, 'ssmMedianMs': cached,
                     'passed': cached <= native * (1 - REQUIRED_REDUCTION)})
    return rows


def change(value, native):
    """'20.0% reduced' or '25.0% increased', relative to native."""
    percent = 100 * (value - native) / native
    return f'{abs(percent):.1f}% {"increased" if percent > 0 else "reduced"}'


if __name__ == '__main__':
    try:
        rows = check_performance(json.loads(Path(sys.argv[1]).read_text()))
    except (ValueError, KeyError, TypeError) as error:
        sys.exit(f'Invalid benchmark result: {error}')
    for row in rows:
        print(f"{row['operation']}: native {row['nativeMedianMs']:.2f} ms · no plugin {row['noPluginMedianMs']:.2f} ms "
              f"({change(row['noPluginMedianMs'], row['nativeMedianMs'])}) · SSM plugin {row['ssmMedianMs']:.2f} ms "
              f"({change(row['ssmMedianMs'], row['nativeMedianMs'])}; required ≥{REQUIRED_REDUCTION:.0%} reduced): "
              f"{'PASS' if row['passed'] else 'FAIL'}")
    sys.exit(0 if all(row['passed'] for row in rows) else 1)
