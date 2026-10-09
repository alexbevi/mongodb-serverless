import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
import subprocess
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('report', Path(__file__).parents[1] / 'report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

class ReportTest(unittest.TestCase):
    def test_published_results_omit_private_infrastructure_identifiers(self):
        root = Path(__file__).parents[2]
        document = (root / 'BENCHMARK.md').read_text()
        self.assertIn('AWS results were collected on a sample application', document)
        self.assertNotRegex(document, r'[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}')
        data = json.loads((root / 'benchmark/aws/samples.json').read_text())
        def inspect(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    self.assertNotIn(key, {'runId', 'roundId', 'requestId', 'environmentId'})
                    inspect(item)
            elif isinstance(value, list):
                for item in value:
                    inspect(item)
            elif isinstance(value, str):
                self.assertNotIn('.mongodb.net', value)
                self.assertNotRegex(value, r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
        inspect(data)

    def test_renders_aws_export_without_inventing_docker_or_ping_measurements(self):
        data = json.loads((Path(__file__).parents[1] / 'aws/samples.json').read_text())
        for sample in data['samples']:
            timeline = report.connection_timeline(sample)
            self.assertAlmostEqual(sum(timeline['phases'].values()), sample['timings']['total'])
        with tempfile.TemporaryDirectory() as directory:
            report.render(data, Path(directory))
            self.assertTrue((Path(directory) / 'latency.png').is_file())
            self.assertTrue((Path(directory) / 'environment.png').is_file())

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

    def test_recovers_two_connections_without_counting_parallel_monitors(self):
        monitor = {'host': 'mongo-a', 'port': 27017, 'start': 3,
                   'tcp': [3, 5], 'tls': [5, 7], 'hello': [8, 11]}
        application = {'host': 'mongo-a', 'port': 27017, 'start': 13,
                       'tcp': [13, 15], 'tls': [15, 18], 'hello': [19, 22],
                       'auth': [23, 27]}
        remote = {'host': 'mongo-b', 'port': 27017, 'start': 1,
                  'tcp': [1, 6], 'tls': [6, 10], 'hello': [10, 30]}
        sample = {'trace': {'start': 0, 'end': 35,
                  'sockets': [remote, monitor, application],
                  'command': {'socket': application, 'start': 29, 'sent': 30, 'end': 34}}}
        recovered = report.connection_timeline(sample)
        self.assertEqual(recovered['phases'], {
            'setup': 3, 'monitor': 8, 'selection': 2, 'application': 14,
            'dispatch': 2, 'send': 1, 'receive': 4, 'completion': 1})
        self.assertEqual(sum(recovered['phases'].values()), 35)
        self.assertEqual([(m['host'], m['start'], m['end']) for m in recovered['parallel_monitors']],
                         [('mongo-b', 1, 30)])
        self.assertEqual(recovered['monitor']['start'], 3)
        self.assertEqual(recovered['monitor']['end'], 11)
        self.assertEqual(recovered['monitor']['duration'], 8)
        self.assertEqual(recovered['application']['duration'], 14)
        self.assertEqual(recovered['application']['phases'], {
            'tcp': 2, 'tls': 3, 'hello': 3, 'auth': 4, 'gaps': 2})
        sample['trace']['sockets'] = [remote, application]
        with self.assertRaisesRegex(ValueError, 'monitor'):
            report.connection_timeline(sample)
        sample['trace']['sockets'] = [monitor, application]
        sample['trace']['command']['start'] = 26
        with self.assertRaisesRegex(ValueError, 'overlap'):
            report.connection_timeline(sample)

        data = json.loads((Path(__file__).parents[1] / 'baseline/samples.json').read_text())
        for sample in data['samples']:
            recovered = report.connection_timeline(sample)
            self.assertAlmostEqual(sum(recovered['phases'].values()), sample['timings']['total'])
            self.assertLessEqual(recovered['monitor']['end'], recovered['application']['start'])
        import matplotlib.pyplot as plt
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'samples.json'
            destination = Path(directory) / 'BENCHMARK.md'
            destination.write_text('My benchmark prose')
            with patch.object(plt, 'close') as close:
                report.render(data, Path(directory))
                figure = close.call_args.args[0]
            timeline = figure.axes[0]
            self.assertEqual(timeline.get_xlabel(), 'Milliseconds since client construction (mean)')
            self.assertEqual([axis.get_title() for axis in figure.axes], ['Read', 'Write'])
            labels = [text.get_text() for text in timeline.texts]
            self.assertTrue(any('1 · Monitoring' in label for label in labels))
            self.assertTrue(any('2 · Application' in label for label in labels))
            self.assertEqual(sum(patch.get_label() == 'TCP / DNS' for patch in timeline.patches), 4)
            native_reads = [report.connection_timeline(sample) for sample in data['samples']
                            if sample['variant'] == 'native' and sample['operation'] == 'read']
            tcp_bars = [bar for bar in timeline.patches if bar.get_label() == 'TCP / DNS'
                        and abs(bar.get_y() + bar.get_height() / 2) < 1e-9]
            for bar, connection in zip(tcp_bars, ('monitor', 'application')):
                intervals = [sample[connection]['intervals']['tcp'] for sample in native_reads]
                self.assertAlmostEqual(bar.get_x(), sum(value[0] for value in intervals) / len(intervals))
                self.assertAlmostEqual(bar.get_width(), sum(b - a for a, b in intervals) / len(intervals))
            parallel = [bar for bar in timeline.patches if bar.get_gid() == 'parallel:mongo-b:tcp']
            self.assertEqual(len(parallel), 1)
            intervals = [next(m for m in t['parallel_monitors'] if m['host'] == 'mongo-b')['intervals']['tcp']
                         for t in native_reads]
            self.assertAlmostEqual(parallel[0].get_x(), sum(a for a, b in intervals) / len(intervals))
            self.assertAlmostEqual(parallel[0].get_width(), sum(b - a for a, b in intervals) / len(intervals))
            self.assertTrue((Path(directory) / 'samples.png').is_file())
            self.assertEqual(destination.read_text(), 'My benchmark prose')
            self.assertTrue((Path(directory) / 'connection-phases.png').exists())
            saved = json.loads((Path(directory) / 'connection-timings.json').read_text())
            self.assertEqual(len(saved), len(data['samples']))
            self.assertAlmostEqual(saved[0]['timeline']['monitor']['duration'],
                                   report.connection_timeline(data['samples'][0])['monitor']['duration'])
            plt.close(figure)

    def test_cli_refreshes_linked_assets_without_rewriting_markdown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'results/run.json'
            source.parent.mkdir()
            data = json.loads((Path(__file__).parents[1] / 'baseline/samples.json').read_text())
            data['createdAt'] = '2030-01-02T03:04:05Z'
            source.write_text(json.dumps(data))
            document = root / 'BENCHMARK.md'
            original = '# My edited benchmark\n\n![Results](assets/results.png)\n'
            document.write_text(original)
            assets = root / 'assets'
            assets.mkdir()
            (assets / 'results.png').write_bytes(b'old image')
            subprocess.run([sys.executable, str(Path(report.__file__).resolve()), str(source),
                            '--output-dir', str(assets)], check=True, capture_output=True)
            self.assertEqual(document.read_text(), original)
            self.assertEqual(json.loads((assets / 'samples.json').read_text()), data)
            for name in ['latency', 'samples', 'results', 'connection-times', 'other-times',
                         'seed-orders', 'connection-phases', 'timeline-segments', 'network', 'environment']:
                self.assertTrue((assets / (name + '.png')).read_bytes().startswith(b'\x89PNG'))
                self.assertIn('<svg', (assets / (name + '.svg')).read_text())
            self.assertIn('2030-01-02', (assets / 'results.svg').read_text())
            self.assertFalse((root / 'BASELINE.md').exists())

    def test_plot_includes_the_full_latency_range(self):
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        data = json.loads((Path(__file__).parents[1] / 'baseline/samples.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'samples.json'
            with patch.object(plt, 'close') as close:
                report.render(data, Path(directory))
                figure = next(call.args[0] for call in close.call_args_list
                              if hasattr(call.args[0], 'axes') and len(call.args[0].axes) == 1
                              and call.args[0].axes[0].get_ylabel().startswith('Milliseconds'))
            upper = figure.axes[0].get_ylim()[1]
            plt.close(figure)
            self.assertGreater(upper, max(s['timings']['total'] for s in data['samples']))

if __name__ == '__main__':
    unittest.main()
