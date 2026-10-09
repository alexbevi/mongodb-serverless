import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
from unittest.mock import patch

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

    def test_plot_includes_the_full_latency_range(self):
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        data = json.loads((Path(__file__).parents[1] / 'baseline/samples.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'samples.json'
            with patch.object(plt, 'close') as close:
                report.render(data, source, Path(directory) / 'BASELINE.md')
                figure = close.call_args.args[0]
            upper = figure.axes[1].get_ylim()[1]
            plt.close(figure)
            self.assertGreater(upper, max(s['timings']['total'] for s in data['samples']))

if __name__ == '__main__':
    unittest.main()
