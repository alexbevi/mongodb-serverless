import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))


class PerformanceTest(unittest.TestCase):
    def test_gate_requires_one_hundred_valid_samples_and_ten_percent_for_both_operations(self):
        from performance import check_performance
        data = {"configuration": {"diagnostics": False}, "samples": [
            {"operation": operation, "variant": variant, "iteration": iteration,
             "verified": True, "timings": {"total": duration}}
            for operation in ('read', 'write')
            for variant, duration in (('native', 100), ('serverless-no-monitoring', 90))
            for iteration in range(100)]}
        result = check_performance(data)
        self.assertTrue(all(row['passed'] for row in result))
        for operation in ('read', 'write'):
            slower = copy.deepcopy(data)
            for sample in slower['samples']:
                if sample['operation'] == operation and sample['variant'] == 'serverless-no-monitoring':
                    sample['timings']['total'] = 90.01
            self.assertEqual([row['operation'] for row in check_performance(slower) if not row['passed']], [operation])
        outlier = copy.deepcopy(data)
        outlier['samples'][-1]['timings']['total'] = 10000
        self.assertTrue(all(row['passed'] for row in check_performance(outlier)))
        for corrupt in ('missing', 'duplicate', 'nan', 'unverified', 'diagnostics'):
            invalid = copy.deepcopy(data)
            if corrupt == 'missing': invalid['samples'].pop()
            if corrupt == 'duplicate': invalid['samples'][-1]['iteration'] = 0
            if corrupt == 'nan': invalid['samples'][-1]['timings']['total'] = float('nan')
            if corrupt == 'unverified': invalid['samples'][-1]['verified'] = False
            if corrupt == 'diagnostics': invalid['configuration']['diagnostics'] = True
            with self.subTest(corrupt=corrupt), self.assertRaises(ValueError):
                check_performance(invalid)


if __name__ == '__main__':
    unittest.main()
