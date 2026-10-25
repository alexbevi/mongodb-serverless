import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))

from event_fixtures import run

AWS = {'operations': {'read': {'ssm': {'phaseMeansMs': {'tls': 38.8}}}}}


class CiSummaryTest(unittest.TestCase):
    def test_summary_shows_each_pattern_with_its_change_from_native(self):
        from ci_summary import render_summary
        data = run(count=4, totals={('native', 'read'): 100.0, ('native', 'write'): 100.0, ('no-plugin', 'read'): 80.0,
                                    ('no-plugin', 'write'): 125.0, ('ssm', 'read'): 70.0, ('ssm', 'write'): 85.0})
        summary = render_summary(data, '24', 'success', 'https://example.com/artifact', AWS)
        self.assertIn('✅ Benchmark passed', summary)
        self.assertIn('| Operation | Native | No plugin | SSM plugin | Gate |', summary)
        self.assertIn('| Read | 100.00 ms | 80.00 ms (20.0% reduced) | 70.00 ms (30.0% reduced) | ✅ |', summary)
        self.assertIn('| Write | 100.00 ms | 125.00 ms (25.0% increased) | 85.00 ms (15.0% reduced) | ✅ |', summary)
        self.assertIn('\\* ', summary)
        self.assertIn('~39 ms', summary)
        self.assertIn('~7 ms', summary)
        self.assertIn('[Download charts and results](https://example.com/artifact)', summary)

    def test_summary_links_each_case_chart(self):
        from ci_summary import render_summary
        charts = {'read-native': 'https://example.com/read-native', 'write-no-plugin-2-connections': 'https://example.com/w2'}
        summary = render_summary(run(count=4, totals={('ssm', 'read'): 50.0, ('ssm', 'write'): 50.0}), '24', 'success', '', AWS, charts)
        self.assertIn('Latency diagrams: [Read · native](https://example.com/read-native) · '
                      '[Write · no plugin, 2 connections](https://example.com/w2)', summary)
        self.assertNotIn('Read · no plugin](', summary)

    def test_summary_reports_a_failed_gate_and_an_incomplete_run(self):
        from ci_summary import render_summary
        data = run(count=4, totals={('ssm', 'write'): 95.0})
        failed = render_summary(data, '24', 'failure', '', None)
        self.assertIn('❌ Benchmark failed', failed)
        self.assertIn('| Write | 100.00 ms | 100.00 ms (0.0% reduced) | 95.00 ms (5.0% reduced) | ❌ |', failed)
        self.assertNotIn('](https:', failed)
        data['samples'].pop()
        self.assertIn('⚠️ Benchmark incomplete', render_summary(data, '24', 'failure', '', None))
        self.assertIn('⚠️ Benchmark incomplete', render_summary(None, '24', 'failure', '', None))


if __name__ == '__main__':
    unittest.main()
