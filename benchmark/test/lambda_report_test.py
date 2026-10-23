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
        self.assertEqual(read['ssm']['meanMs'], 40)
        self.assertAlmostEqual(read['ssm']['standardDeviationMs'], 200 ** .5)
        self.assertAlmostEqual(read['ssm']['coefficientOfVariationPercent'], 100 * 200 ** .5 / 40)
        self.assertEqual(read['ssm']['medianAbsoluteDeviationMs'], 10)
        self.assertEqual(summary['writeLandings']['oneConnection']['count'], 1)
        self.assertEqual(summary['writeLandings']['twoConnections']['medianMs'], 90)
        self.assertEqual(summary['writeLandings']['oneConnection']['sharePercent'], 50)
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

    def test_timeline_accounts_for_ssm_seed_discovery_and_role_validation(self):
        seed = dict(host='seed', port=27017, start=112, role='SECONDARY', tcp=[112, 114], auth=[114, 116])
        target = dict(host='primary', port=27017, start=130, role='PRIMARY', tcp=[130, 132], auth=[132, 134])
        item = sample('no-plugin', 'write', 50, sockets=2)
        item['trace'] = dict(start=100, end=150, sockets=[seed, target], dns=[],
            ssm=[dict(start=101, end=110, command='GetParameterCommand')],
            command=dict(name='update', start=142, sent=143, end=145, socket=target),
            exchanges=[dict(name='replSetGetStatus', start=118, end=121, socket=seed),
                       dict(name='hello', start=136, end=138, socket=target)],
            activities=[dict(name='Native URI/options parsing', kind='sync', start=110, end=111)],
            execution=dict(start=100, end=150, threadCpuMs=3, segments=[
                dict(kind='callback', start=100, end=150, threadCpuMs=3)]))
        timeline = report.timeline(item)
        segments = report.breakdown.accounting_segments(timeline)
        totals = report.breakdown.accounting_totals(timeline)
        self.assertEqual(sum(totals.values()), 50)
        self.assertEqual(totals['ssm'], 9)
        self.assertEqual(totals['discovery'], 3)
        self.assertEqual(totals['roleCheck'], 2)
        self.assertEqual(totals['tcp'], 4)
        self.assertEqual(totals['unattributed'], 0)
        self.assertEqual([c['selected'] for c in timeline['connections']], [False, True])
        self.assertEqual(segments[0]['start'], 0)
        self.assertEqual(segments[-1]['end'], 50)
        for left, right in zip(segments, segments[1:]):
            self.assertEqual(left['end'], right['start'])
        del item['trace']['execution']
        with self.assertRaisesRegex(ValueError, 'diagnostics'):
            report.timeline(item)

    def test_protocol_only_traces_account_for_unmeasured_work_without_inventing_cpu_detail(self):
        socket = dict(host='primary', start=110, role='PRIMARY', tcp=[110, 120], tls=[120, 130], hello=[130, 135], auth=[135, 140])
        monitor = dict(host='primary', start=105, role='PRIMARY', tcp=[105, 115], tls=[115, 125], hello=[125, 130])
        item = sample('native', 'read', 50, sockets=2)
        item['trace'] = dict(start=100, end=150, sockets=[monitor, socket], ssm=[],
            dns=[dict(kind='SRV', start=101, end=104)], exchanges=[],
            command=dict(start=145, sent=146, end=149, socket=socket))
        timeline = report.timeline(item)
        totals = report.breakdown.accounting_totals(timeline)
        self.assertEqual(sum(totals.values()), 50)
        self.assertEqual(totals['monitor'], 5)
        self.assertEqual(totals['tls'], 10)
        self.assertEqual(totals['other'], 8)
        self.assertEqual(totals['unattributed'], 0)
        self.assertNotIn('execution', timeline)
        self.assertNotIn('threadCpuMs', timeline)
        lane = next(lane for lane in report.handler_lanes(item) if lane['kind'] == 'code')
        self.assertEqual(sum(span['end']-span['start'] for span in lane['spans']), 8)
        self.assertTrue(all(span['phase'] == 'other' for span in lane['spans']))

    def test_handler_overview_averages_every_phase_and_selects_without_init(self):
        samples = []
        for variant in ['native', 'no-plugin', 'ssm']:
            for operation in ['read', 'write']:
                for iteration, (total, init) in enumerate([(30, 100), (40, 400), (80, 10)]):
                    socket = dict(host='member', start=101, role='PRIMARY', tcp=[101, 103],
                                  tls=[103, 108], hello=[108, 110], auth=[110, 112])
                    item = sample(variant, operation, total)
                    item.update(iteration=iteration, ssmMs=5, ssmPhase='init', initialization=dict(ssm=[dict(start=1, end=6)]))
                    item['lambda'] = dict(initMs=init)
                    item['trace'] = dict(start=100, end=100+total, sockets=[socket], dns=[], ssm=[], exchanges=[],
                        command=dict(start=100+total-5, sent=100+total-4, end=100+total-1, socket=socket))
                    samples.append(item)
        data = dict(configuration=dict(count=3, overview='handler', diagnostics=False), samples=samples, failures=[])
        summary = report.summarize(data)
        group = summary['operations']['read']['ssm']
        self.assertEqual(group['meanMs'], 50)
        self.assertAlmostEqual(sum(group['phaseMeansMs'].values()), 50)
        self.assertEqual(group['phaseMeansMs']['other'], 35)
        self.assertEqual(group['phaseMeansMs']['ssm'], 0)
        self.assertNotIn('init', group['phaseMeansMs'])
        self.assertLess(group['meanConfidence95Ms'][0], 50)
        self.assertGreater(group['meanConfidence95Ms'][1], 50)
        self.assertTrue(all(case['sample']['iteration'] == 1 for case in report.illustrated_cases(data)))
        text = report.markdown(summary)
        self.assertIn('Mean', text)
        self.assertIn('Other handler work / scheduling', text)
        self.assertNotIn('INIT median', text)
        self.assertNotIn('INIT + handler median', text)

    def test_uncached_ssm_column_counts_discovery_and_storage_but_excludes_init_read(self):
        import tempfile
        variants = ['native', 'no-plugin', 'ssm', 'ssm-uncached']
        samples = []
        for variant in variants:
            for operation in ['read', 'write']:
                for iteration in range(2):
                    target = dict(host='primary', start=105, role='PRIMARY', tcp=[105, 107],
                                  tls=[107, 112], hello=[112, 114], auth=[114, 116])
                    sockets = [target]
                    if variant == 'no-plugin' and operation == 'write' and iteration == 1:
                        sockets.insert(0, dict(host='secondary', start=101, role='SECONDARY',
                                              tcp=[101, 102], auth=[102, 104]))
                    item = sample(variant, operation, 50, len(sockets))
                    item.update(iteration=iteration, ssmMs=5, ssmPhase='init',
                                initialization=dict(ssm=[dict(start=1, end=6, command='GetParametersCommand')]))
                    item['lambda'] = dict(initMs=20)
                    miss = variant == 'ssm-uncached'
                    item['trace'] = dict(start=100, end=150, sockets=sockets, dns=[],
                        ssm=[dict(start=125, end=133, command='PutParameterCommand')] if miss else [],
                        exchanges=[dict(name='replSetGetStatus', start=120, end=123, socket=target)] if miss else [],
                        command=dict(start=140, sent=141, end=145, socket=target))
                    samples.append(item)
        data = dict(configuration=dict(count=2, variants=variants, overview='handler', diagnostics=False,
                                       environment='Synthetic', memoryMB=1769), samples=samples, failures=[])
        summary = report.summarize(data)
        self.assertEqual(set(summary['operations']['read']), set(variants))
        for operation in ['read', 'write']:
            phases = summary['operations'][operation]['ssm-uncached']['phaseMeansMs']
            self.assertEqual(phases['topologyStore'], 8)
            self.assertEqual(phases['discovery'], 3)
            self.assertEqual(phases['ssm'], 0)
            self.assertAlmostEqual(sum(phases.values()), 50)
        text = report.markdown(summary)
        self.assertIn('aws-ssm · no cached topology', text)
        self.assertIn('Topology storage · SSM PutParameter', text)
        self.assertIn('![Measured read connection breakdown](read-latency.png)', text)
        self.assertIn('![Measured write connection breakdown](write-latency.png)', text)
        self.assertEqual(next(lane['label'] for lane in report.handler_lanes(samples[-1]) if lane['kind'] == 'ssm'), 'SSM · topology write')
        self.assertNotIn('INIT median', text)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            report.render(data, summary, output)
            self.assertTrue((output / 'read-latency.png').read_bytes().startswith(b'\x89PNG'))
            self.assertTrue((output / 'write-latency.png').read_bytes().startswith(b'\x89PNG'))
        self.assertEqual(len(summary['illustratedTraces']), 9)
        self.assertEqual(sum(trace['pattern'] == 'aws-ssm · no cached topology' for trace in summary['illustratedTraces']), 2)
