import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('lambda_report', Path(__file__).parents[1] / 'lambda-report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def sample(variant, operation, ms, sockets=1):
    return dict(variant=variant, operation=operation, totalMs=ms, ssmMs=10,
                sockets=sockets, verified=True, cold=True, lambda_={})


class ReportTest(unittest.TestCase):
    def test_summarizes_current_patterns_and_keeps_natural_write_cohorts(self):
        samples = []
        for operation in ['read', 'write']:
            for variant, values in [('native', [100, 120]), ('no-plugin', [50, 90]), ('ssm', [30, 50])]:
                samples.extend(sample(variant, operation, value, 2 if variant == 'no-plugin' and operation == 'write' and value == 90 else 1) for value in values)
        summary = report.summarize(dict(configuration={'count': 2}, samples=samples, failures=[]))
        read = summary['operations']['read']
        self.assertEqual(read['ssm']['medianMs'], 40)
        self.assertEqual(summary['writeLandings']['oneConnection']['count'], 1)
        self.assertEqual(summary['writeLandings']['twoConnections']['medianMs'], 90)
        self.assertEqual(summary['writeLandings']['oneConnection']['sharePercent'], 50)
        self.assertAlmostEqual(summary['luckyWriteMedianReductionPercent'], 100 * (1 - 50 / 90))
        self.assertGreater(read['no-plugin']['p95Ms'], read['no-plugin']['medianMs'])
        samples[-1]['verified'] = False
        with self.assertRaisesRegex(ValueError, 'verified'):
            report.summarize(dict(configuration={'count': 2}, samples=samples, failures=[]))

    def test_missing_cohort_is_not_reported_as_zero_latency(self):
        samples = [sample(variant, operation, 10) for variant in ['native', 'no-plugin', 'ssm'] for operation in ['read', 'write']]
        summary = report.summarize(dict(configuration={'count': 1}, samples=samples, failures=[]))
        self.assertIsNone(summary['writeLandings']['twoConnections']['medianMs'])
        with self.assertRaisesRegex(ValueError, 'count'):
            report.summarize(dict(configuration={'count': 2}, samples=samples, failures=[]))
        with self.assertRaisesRegex(ValueError, 'failures'):
            report.summarize(dict(configuration={'count': 1}, samples=samples, failures=[{'name': 'error'}]))

    def test_current_report_needs_no_prior_revision_or_control(self):
        samples = [sample(variant, operation, 50) for variant in ['native', 'no-plugin', 'ssm'] for operation in ['read', 'write']]
        summary = report.summarize(dict(configuration={'count': 1}, samples=samples, failures=[]))
        self.assertEqual(set(summary['operations']['read']), {'native', 'no-plugin', 'ssm'})
        import json
        for text in [json.dumps(summary), report.markdown(summary)]:
            for reference in ['main', 'historical', 'baseline', 'improvementVs']:
                self.assertNotIn(reference, text)

    def test_keeps_lambda_init_separate_from_handler_latency(self):
        samples = []
        for variant in ['native', 'no-plugin', 'ssm']:
            for operation in ['read', 'write']:
                for ms, init in [(30, 200), (50, 400)]:
                    item = sample(variant, operation, ms)
                    item['lambda'] = dict(initMs=init, durationMs=ms + 5)
                    samples.append(item)
        summary = report.summarize(dict(configuration={'count': 2}, samples=samples, failures=[]))
        group = summary['operations']['read']['ssm']
        self.assertEqual(group['medianMs'], 40)
        self.assertEqual(group['medianInitMs'], 300)
        self.assertEqual(group['medianInitPlusHandlerMs'], 340)
