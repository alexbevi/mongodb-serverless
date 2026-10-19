import importlib.util
import unittest
from copy import deepcopy
from pathlib import Path


class ColdStartReportTest(unittest.TestCase):
    def test_selects_by_init_plus_read_and_keeps_request_work_off_socket_lanes(self):
        spec = importlib.util.spec_from_file_location('cold_start_report', Path(__file__).parents[1] / 'cold-start-report.py')
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        connection = dict(host='secondary', port=27017, role='SECONDARY', start=115,
                          tcp=[115, 117], tls=[117, 122], hello=[122, 125], auth=[125, 129])
        trace = dict(start=100, end=150, sockets=[connection],
                     ssm=[dict(start=101, end=110)], dns=[dict(kind='SRV', start=111, end=114)],
                     exchanges=[dict(name='hello', start=133, end=135, socket=connection),
                                dict(name='replSetGetStatus', start=137, end=140, socket=connection)],
                     command=dict(name='find', start=145, sent=146, end=149, socket=connection),
                     activities=[dict(name='Native URI/options parsing', kind='sync', start=110, end=111)],
                     execution=dict(threadCpuMs=2, segments=[dict(kind='callback', start=100, end=150, threadCpuMs=2)]))
        samples = []
        for iteration, init, total in [(0, 300, 50), (1, 100, 55), (2, 200, 60)]:
            current = deepcopy(trace)
            current['end'] = 100 + total
            current['execution']['segments'][0]['end'] = 100 + total
            samples.append(dict(iteration=iteration, variant='no-plugin', operation='read',
                                totalMs=total, cold=True, verified=True, trace=current,
                                **{'lambda': dict(initMs=init)}))
        case = report.read_case(samples)
        self.assertEqual(case['iteration'], 2)
        self.assertEqual(case['medianMs'], 260)
        self.assertEqual(case['totalMs'], 260)
        self.assertEqual(case['initMs'], 200)
        self.assertAlmostEqual(sum(case['accountingMs'].values()), 260)
        self.assertEqual(case['accountingMs']['ssm'], 9)
        lane = next(lane for lane in case['lanes'] if lane['kind'] == 'connection')
        self.assertTrue(all(span['start'] >= 15 for span in lane['spans']))
        self.assertFalse(any(span['phase'] == 'ssm' for span in lane['spans']))
        self.assertEqual(next(span for span in lane['spans'] if span['phase'] == 'discovery')['start'], 37)
        self.assertEqual(next(span for span in lane['spans'] if span['phase'] == 'roleCheck')['start'], 33)
        self.assertEqual(next(span for span in lane['spans'] if span['phase'] == 'receive')['start'], 46)
        self.assertEqual(next(lane for lane in case['lanes'] if lane['kind'] == 'ssm')['spans'][0]['start'], 1)
        samples[0]['lambda']['initMs'] = None
        with self.assertRaisesRegex(ValueError, 'INIT'):
            report.read_case(samples)
