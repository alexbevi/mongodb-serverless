"""Require a 10% median latency reduction in both cold-operation cohorts."""
import json
import math
import sys
from pathlib import Path
from statistics import median


def check_performance(data):
    if data['configuration'].get('diagnostics'):
        raise ValueError('Performance gate requires diagnostics to be disabled')
    results = []
    for operation in ('read', 'write'):
        medians = {}
        for variant in ('native', 'serverless-no-monitoring'):
            samples = [sample for sample in data['samples']
                       if sample['operation'] == operation and sample['variant'] == variant]
            if len(samples) != 100 or {sample['iteration'] for sample in samples} != set(range(100)):
                raise ValueError(f'{operation}/{variant}: expected exactly 100 distinct iterations')
            durations = [sample['timings']['total'] for sample in samples]
            if not all(sample['verified'] is True for sample in samples):
                raise ValueError(f'{operation}/{variant}: operation verification failed')
            if not all(math.isfinite(value) and value > 0 for value in durations):
                raise ValueError(f'{operation}/{variant}: invalid latency')
            medians[variant] = median(durations)
        native, direct = medians['native'], medians['serverless-no-monitoring']
        results.append({'operation': operation, 'nativeMedianMs': native,
                        'serverlessMedianMs': direct, 'improvementPercent': 100 * (1 - direct / native),
                        'passed': direct <= native * 0.9})
    return results


if __name__ == '__main__':
    try:
        results = check_performance(json.loads(Path(sys.argv[1]).read_text()))
    except (ValueError, KeyError, TypeError) as error:
        sys.exit(f'Invalid benchmark result: {error}')
    for result in results:
        print(f"{result['operation']}: median {result['nativeMedianMs']:.3f} → "
              f"{result['serverlessMedianMs']:.3f} ms; improvement {result['improvementPercent']:.3f}% "
              f"(required ≥10%): {'PASS' if result['passed'] else 'FAIL'}")
    sys.exit(0 if all(result['passed'] for result in results) else 1)
