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
            self.assertEqual({p.name for p in directory.iterdir()}, {'samples.json', 'summary.json', 'results.md', 'latency.png'})
            data = json.loads((directory / 'samples.json').read_text())
            summary = json.loads((directory / 'summary.json').read_text())
            self.assertFalse(data['failures'])
            self.assertNotIn('.mongodb.net', (directory / 'samples.json').read_text())
            self.assertNotIn('mongodb+srv://', (directory / 'samples.json').read_text())
            self.assertTrue(data['configuration']['diagnostics'])
            self.assertEqual({s['variant'] for s in data['samples']}, {'native', 'no-plugin', 'ssm'})
            for operation in ['read', 'write']:
                for variant in ['native', 'no-plugin', 'ssm']:
                    cohort = [s for s in data['samples'] if s['variant'] == variant and s['operation'] == operation]
                    self.assertEqual(len(cohort), data['configuration']['count'])
                    self.assertEqual(summary['operations'][operation][variant]['count'], len(cohort))
                    for sample in cohort:
                        self.assertTrue(sample['verified'] and sample['cold'])
                        self.assertEqual(sample['trace']['execution']['start'], sample['trace']['start'])
                        self.assertEqual(sample['trace']['execution']['end'], sample['trace']['end'])
            for trace in summary['illustratedTraces']:
                self.assertAlmostEqual(sum(trace['accountingMs'].values()), trace['totalMs'])
                self.assertEqual(trace['accountingMs']['unattributed'], 0)
            for document in ['samples.json', 'summary.json', 'results.md']:
                text = (directory / document).read_text()
                for forbidden in ['historicalBaseline', 'improvementVs', '"baseline":', '"main"', 'previous main']:
                    self.assertNotIn(forbidden, text)
            self.assertTrue((directory / 'latency.png').read_bytes().startswith(b'\x89PNG'))

    def test_latest_runs_fetch_settings_before_handler_entry_and_reuse_warm_clients(self):
        for environment in ['local', 'aws']:
            data = json.loads((Path(__file__).parents[1] / 'results' / environment / 'samples.json').read_text())
            self.assertGreater(data['configuration']['packageZipBytes'], 0)
            checks = data['configuration']['warmVerification']
            self.assertEqual(len(checks), 6)
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
                self.assertEqual(sample['trace']['ssm'], [])
                self.assertTrue(all(socket['start'] >= sample['trace']['start'] for socket in sample['trace']['sockets']))
                calls = sample['initialization']['ssm']
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0]['command'], 'GetParametersCommand' if sample['variant'] == 'ssm' else 'GetParameterCommand')
                self.assertLessEqual(calls[0]['end'], sample['initialization']['processReadyMs'])
                self.assertLessEqual(sample['initialization']['processReadyMs'], sample['trace']['start'])
                self.assertAlmostEqual(calls[0]['end'] - calls[0]['start'], sample['ssmMs'])
                self.assertGreater(sample['lambda']['initMs'], sample['ssmMs'])
                self.assertEqual(sample['lambda']['initSource'], 'lambda-report' if environment == 'aws' else 'node-process-clock')
