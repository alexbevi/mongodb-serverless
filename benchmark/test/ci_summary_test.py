import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))


class CiSummaryTest(unittest.TestCase):
    def test_summary_reports_gate_results_and_available_artifacts(self):
        from ci_summary import render_summary
        data = {'configuration': {'diagnostics': False}, 'samples': [
            {'operation': operation, 'variant': variant, 'iteration': iteration,
             'verified': True, 'timings': {'total': duration}}
            for operation in ('read', 'write')
            for variant, duration in (('native', 100), ('serverless-no-monitoring', 80))
            for iteration in range(100)]}
        summary = render_summary(data, '24', 'success', 'https://example.com/png', 'https://example.com/json')
        self.assertIn('✅ Benchmark passed', summary)
        self.assertIn('| Read | 100.00 ms | 80.00 ms | **20.00%** | ✅ |', summary)
        self.assertIn('[Open latency diagram](https://example.com/png)', summary)
        self.assertIn('[Download result JSON](https://example.com/json)', summary)
        for sample in data['samples']:
            if sample['operation'] == 'write' and sample['variant'] == 'serverless-no-monitoring':
                sample['timings']['total'] = 95
        summary = render_summary(data, '24', 'failure', '', '')
        self.assertIn('❌ Benchmark failed', summary)
        self.assertIn('| Write | 100.00 ms | 95.00 ms | **5.00%** | ❌ |', summary)
        self.assertNotIn('](https:', summary)
        data['samples'].pop()
        self.assertIn('Invalid benchmark result', render_summary(data, '24', 'failure', '', ''))
        self.assertIn('No result JSON', render_summary(None, '24', 'cancelled', '', ''))


if __name__ == '__main__':
    unittest.main()
