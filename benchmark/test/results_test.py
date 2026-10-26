"""Check the published local and AWS measurements are complete, consistent and free of secrets."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from report import load

ROOT = Path(__file__).parents[1] / 'results'
CASES = ['read-native', 'read-no-plugin', 'read-ssm', 'read-ssm-uncached', 'write-native',
         'write-no-plugin-1-connection', 'write-no-plugin-2-connections', 'write-ssm', 'write-ssm-uncached']


class ResultsTest(unittest.TestCase):
    def test_only_the_latest_local_and_aws_results_are_published(self):
        self.assertEqual({p.name for p in ROOT.iterdir() if p.is_dir()}, {'local', 'aws'})
        for environment in ['local', 'aws']:
            directory = ROOT / environment
            self.assertEqual({p.name for p in directory.iterdir()},
                             {'samples.json.gz', 'summary.json', 'results.md', *(f'{case}.png' for case in CASES)}, environment)
            text = json.dumps(load(directory / 'samples.json.gz'))
            self.assertNotIn('.mongodb.net', text)
            self.assertNotIn('mongodb+srv://', text)
            results = (directory / 'results.md').read_text()
            for case in CASES:
                self.assertTrue((directory / f'{case}.png').read_bytes().startswith(b'\x89PNG'))
                self.assertIn(f'({case}.png)', results)

    def test_summaries_match_complete_verified_cohorts(self):
        for environment in ['local', 'aws']:
            data = load(ROOT / environment / 'samples.json.gz')
            summary = json.loads((ROOT / environment / 'summary.json').read_text())
            self.assertFalse(data['failures'])
            count = data['configuration']['count']
            for operation in ['read', 'write']:
                for variant in data['configuration']['variants']:
                    cohort = [s for s in data['samples'] if s['variant'] == variant and s['operation'] == operation]
                    self.assertEqual(len(cohort), count)
                    self.assertTrue(all(s['verified'] and s['cold'] for s in cohort))
                    group = summary['operations'][operation][variant]
                    self.assertEqual(group['count'], count)
                    self.assertAlmostEqual(sum(group['phaseMeansMs'].values()), group['meanMs'])

    def test_settings_are_fetched_at_startup_and_warm_calls_reuse_clients(self):
        for environment in ['local', 'aws']:
            data = load(ROOT / environment / 'samples.json.gz')
            checks = data['configuration']['warmVerification']
            self.assertEqual(len(checks), 2 * len(data['configuration']['variants']))
            for check in checks:
                self.assertTrue(check['verified'] and check['sameEnvironment'] and check['sameClient'])
                self.assertEqual(check['ssmReads'] + check['ssmWrites'] + check['discoveryCommands'], 0)
                if check['variant'] != 'native':
                    self.assertTrue(check['sameSocket'])
                    self.assertEqual(check['sockets'], 0)
            for sample in data['samples']:
                trace = sample['trace']
                self.assertEqual(sample['ssmPhase'], 'init')
                self.assertEqual(sample['clientConstructions'], 1)
                self.assertEqual(len(trace['ssm']), 1 if sample['variant'] == 'ssm-uncached' else 0)
                self.assertTrue(all(c['command'] == 'PutParameterCommand' and trace['start'] <= c['start'] < c['end'] <= trace['end'] for c in trace['ssm']))
                self.assertTrue(all(trace['start'] <= socket['start'] <= trace['end'] for socket in trace['sockets']))
                calls = sample['initialization']['ssm']
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0]['command'], 'GetParametersCommand' if sample['variant'] in ['ssm', 'ssm-uncached'] else 'GetParameterCommand')
                self.assertLessEqual(sample['initialization']['processReadyMs'], trace['start'])
                self.assertEqual(sample['lambda']['initSource'], 'lambda-report' if environment == 'aws' else 'node-process-clock')

    def test_the_readme_shows_an_aws_chart(self):
        readme = (Path(__file__).parents[2] / 'README.md').read_text()
        self.assertIn('benchmark/results/aws/read-ssm.png', readme)


if __name__ == '__main__':
    unittest.main()
