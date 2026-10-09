import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('report', Path(__file__).parents[1] / 'report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

class ReportTest(unittest.TestCase):
    def test_stacked_means_add_to_mean_total_without_claiming_to_be_medians(self):
        samples = [{'variant': 'native', 'operation': 'read', 'timings': {
            'tcp': 1, 'tls': 1, 'hello': 1, 'auth': 1, 'send': 1, 'receive': 1,
            'other': total - 6, 'total': total,
        }} for total in [10, 20, 90]]
        result = report.summarize(samples)[('native', 'read')]
        self.assertEqual(result['median'], 20)
        self.assertEqual(result['p95'], 90)
        self.assertEqual(result['mean'], 40)
        self.assertEqual(sum(result['phases'].values()), result['mean'])

if __name__ == '__main__':
    unittest.main()
