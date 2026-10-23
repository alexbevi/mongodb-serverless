"""Keep the published measurements independent of temporary PR comparisons."""
import json
from pathlib import Path
import unittest


class ResultsTest(unittest.TestCase):
    def test_only_latest_complete_local_and_aws_results_are_published(self):
        root = Path(__file__).parents[1] / 'results'
        self.assertEqual({p.name for p in root.iterdir() if p.is_dir()}, {'local', 'aws'})
        for environment in ['local', 'aws']:
            directory = root / environment
            self.assertEqual(
                {p.name for p in directory.iterdir()},
                {'samples.json', 'summary.json', 'results.md', 'read-latency.png', 'write-latency.png'}
            )
            data = json.loads((directory / 'samples.json').read_text())
            summary = json.loads((directory / 'summary.json').read_text())
            self.assertFalse(data['failures'])
            self.assertNotIn('.mongodb.net', (directory / 'samples.json').read_text())
            self.assertNotIn('mongodb+srv://', (directory / 'samples.json').read_text())
            diagnostics = data['configuration']['diagnostics']
            self.assertEqual(summary['configuration']['diagnostics'], diagnostics)
            if not diagnostics:
                self.assertEqual(data['executionSources'], [])
            variants = data['configuration'].get('variants', ['native', 'no-plugin', 'ssm'])
            self.assertEqual({s['variant'] for s in data['samples']}, set(variants))
            for operation in ['read', 'write']:
                for variant in variants:
                    cohort = [s for s in data['samples'] if s['variant'] == variant and s['operation'] == operation]
                    self.assertEqual(len(cohort), data['configuration']['count'])
                    group = summary['operations'][operation][variant]
                    self.assertEqual(group['count'], len(cohort))
                    if data['configuration'].get('overview') == 'handler':
                        self.assertAlmostEqual(sum(group['phaseMeansMs'].values()), group['meanMs'])
                        self.assertNotIn('init', group['phaseMeansMs'])
                        self.assertEqual(group['phaseMeansMs']['ssm'], 0)
                    for sample in cohort:
                        self.assertTrue(sample['verified'] and sample['cold'])
                        if diagnostics:
                            self.assertEqual(sample['trace']['execution']['start'], sample['trace']['start'])
                            self.assertEqual(sample['trace']['execution']['end'], sample['trace']['end'])
                        else:
                            self.assertNotIn('execution', sample['trace'])
                            self.assertNotIn('activities', sample['trace'])
            for trace in summary['illustratedTraces']:
                self.assertAlmostEqual(sum(trace['accountingMs'].values()), trace['totalMs'])
                self.assertEqual(trace['accountingMs']['unattributed'], 0)
                if data['configuration'].get('overview') == 'handler':
                    self.assertEqual(trace['totalMs'], trace['handlerMs'])
                    self.assertNotIn('init', trace['accountingMs'])
            for document in ['samples.json', 'summary.json', 'results.md']:
                text = (directory / document).read_text()
                for forbidden in ['historicalBaseline', 'improvementVs', '"baseline":', '"main"', 'previous main']:
                    self.assertNotIn(forbidden, text)
            for operation in ['read', 'write']:
                self.assertTrue((directory / f'{operation}-latency.png').read_bytes().startswith(b'\x89PNG'))

    def test_published_documents_place_the_split_aws_charts(self):
        root = Path(__file__).parents[2]
        read_chart = 'benchmark/results/aws/read-latency.png'
        write_chart = 'benchmark/results/aws/write-latency.png'
        readme = (root / 'README.md').read_text()
        benchmark = (root / 'BENCHMARK.md').read_text()

        self.assertIn(read_chart, readme)
        self.assertNotIn(write_chart, readme)
        self.assertIn(read_chart, benchmark)
        self.assertIn(write_chart, benchmark)

    def test_latest_runs_fetch_settings_before_handler_entry_and_reuse_warm_clients(self):
        for environment in ['local', 'aws']:
            data = json.loads((Path(__file__).parents[1] / 'results' / environment / 'samples.json').read_text())
            self.assertGreater(data['configuration']['packageZipBytes'], 0)
            checks = data['configuration']['warmVerification']
            self.assertEqual(len(checks), 2 * len(data['configuration'].get('variants', ['native', 'no-plugin', 'ssm'])))
            for check in checks:
                self.assertTrue(check['verified'] and check['sameEnvironment'] and check['sameClient'])
                self.assertEqual(check['ssmReads'] + check['ssmWrites'] + check['discoveryCommands'], 0)
                self.assertEqual(check['dns'], [])
                if check['variant'] != 'native':
                    self.assertTrue(check['sameSocket'])
                    self.assertEqual(check['sockets'], 0)
            for sample in data['samples']:
                self.assertEqual(sample['ssmPhase'], 'init')
                self.assertEqual(sample['clientConstructions'], 1)
                stores = sample['trace']['ssm']
                self.assertEqual(len(stores), 1 if sample['variant'] == 'ssm-uncached' else 0)
                self.assertTrue(all(call['command'] == 'PutParameterCommand' and sample['trace']['start'] <= call['start'] < call['end'] <= sample['trace']['end'] for call in stores))
                self.assertTrue(all(socket['start'] >= sample['trace']['start'] for socket in sample['trace']['sockets']))
                calls = sample['initialization']['ssm']
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0]['command'], 'GetParametersCommand' if sample['variant'] in ['ssm', 'ssm-uncached'] else 'GetParameterCommand')
                self.assertLessEqual(calls[0]['end'], sample['initialization']['processReadyMs'])
                self.assertLessEqual(sample['initialization']['processReadyMs'], sample['trace']['start'])
                self.assertAlmostEqual(calls[0]['end'] - calls[0]['start'], sample['ssmMs'])
                self.assertGreater(sample['lambda']['initMs'], sample['ssmMs'])
                self.assertEqual(sample['lambda']['initSource'], 'lambda-report' if environment == 'aws' else 'node-process-clock')
