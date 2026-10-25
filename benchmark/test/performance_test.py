import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))

from event_fixtures import run


class PerformanceTest(unittest.TestCase):
    def test_gate_requires_the_cached_plugin_ten_percent_below_native_for_both_operations(self):
        from performance import check_performance
        data = run(count=4, totals={('native', 'read'): 100.0, ('native', 'write'): 100.0,
                                    ('ssm', 'read'): 90.0, ('ssm', 'write'): 90.0, ('no-plugin', 'write'): 120.0})
        rows = check_performance(data)
        self.assertTrue(all(row['passed'] for row in rows))
        write = next(row for row in rows if row['operation'] == 'write')
        self.assertEqual((write['nativeMedianMs'], write['noPluginMedianMs'], write['ssmMedianMs']), (100, 120, 90))
        for operation in ('read', 'write'):
            slower = copy.deepcopy(data)
            for sample in slower['samples']:
                if sample['operation'] == operation and sample['variant'] == 'ssm':
                    sample['totalMs'] = 90.01
            self.assertEqual([row['operation'] for row in check_performance(slower) if not row['passed']], [operation])

    def test_gate_rejects_incomplete_or_invalid_runs(self):
        from performance import check_performance
        data = run(count=4, totals={('ssm', 'read'): 50.0, ('ssm', 'write'): 50.0})
        for corrupt in ('missing', 'duplicate', 'nan', 'unverified', 'failure'):
            invalid = copy.deepcopy(data)
            if corrupt == 'missing':
                invalid['samples'].pop()
            if corrupt == 'duplicate':
                invalid['samples'][1]['iteration'] = invalid['samples'][0]['iteration'] = 0
                invalid['samples'][1].update(operation=invalid['samples'][0]['operation'], variant=invalid['samples'][0]['variant'])
            if corrupt == 'nan':
                invalid['samples'][0]['totalMs'] = float('nan')
            if corrupt == 'unverified':
                invalid['samples'][0]['verified'] = False
            if corrupt == 'failure':
                invalid['failures'] = [{'name': 'Error', 'message': 'x'}]
            with self.assertRaises(ValueError, msg=corrupt):
                check_performance(invalid)


class LoadTest(unittest.TestCase):
    def test_gate_reads_plain_or_gzipped_samples(self):
        import gzip, json, tempfile
        from performance import load_samples
        data = run(count=1)
        with tempfile.TemporaryDirectory() as directory:
            plain, packed = Path(directory) / 'samples.json', Path(directory) / 'samples.json.gz'
            plain.write_text(json.dumps(data))
            packed.write_bytes(gzip.compress(json.dumps(data).encode()))
            self.assertEqual(load_samples(plain), load_samples(packed))


if __name__ == '__main__':
    unittest.main()
