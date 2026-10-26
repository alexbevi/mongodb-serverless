import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))

from event_fixtures import run, sample


class AccountingTest(unittest.TestCase):
    def test_every_millisecond_is_counted_once_by_priority(self):
        from report import accounting_segments
        segments = accounting_segments(sample('ssm', 'read'))
        self.assertEqual(segments[0]['start'], 0)
        self.assertEqual(segments[-1]['end'], 100)
        for left, right in zip(segments, segments[1:]):
            self.assertEqual(left['end'], right['start'])
        self.assertEqual([s['phase'] for s in segments],
                         ['setup', 'lookup', 'tcp', 'tls', 'hello', 'auth', 'checkout', 'operation', 'result'])
        operation = next(s for s in segments if s['phase'] == 'operation')
        self.assertEqual((operation['start'], operation['end']), (32, 35))

    def test_setup_runs_until_the_first_member_socket_opens(self):
        from report import accounting_segments, member_rows
        late = sample('ssm', 'read')
        for phase in ('lookup', 'tcp', 'tls', 'hello', 'auth'):
            late['trace']['sockets'][0][phase] = [t + 3 for t in late['trace']['sockets'][0][phase]]
        late['trace']['sockets'][0]['start'] += 3
        segments = accounting_segments(late)
        self.assertEqual(segments[0], {'phase': 'setup', 'start': 0, 'end': 13})
        operation_row = member_rows(late, ['member-1'])[0]
        self.assertNotIn(('other', 10, 13), operation_row['spans'])

    def test_gaps_are_named_by_the_event_they_follow(self):
        from report import accounting_segments
        def plain(segments):
            return [{key: value for key, value in segment.items() if key != 'member'} for segment in segments]

        ready = sample('ssm', 'read')
        ready['trace']['checkouts'] = []
        self.assertIn({'phase': 'prepare', 'start': 30, 'end': 32}, plain(accounting_segments(ready)))
        discovered = sample('ssm-uncached', 'write', two_connections=True)
        discovered['trace']['checkouts'] = []
        self.assertIn({'phase': 'routing', 'start': 34, 'end': 35}, plain(accounting_segments(discovered)))

    def test_command_preparation_is_drawn_on_the_member_that_became_ready(self):
        from report import member_rows
        discovered = sample('ssm-uncached', 'write', two_connections=True)
        discovered['trace']['checkouts'] = []
        operation_row, first_row = member_rows(discovered, ['member-1', 'member-2'])
        self.assertIn(('prepare', 30, 31), first_row['spans'])
        self.assertNotIn(('prepare', 30, 31), operation_row['spans'])
        self.assertTrue(any(phase == 'waiting' and left <= 30 and right >= 31 for phase, left, right in operation_row['spans']))

    def test_monitor_handshakes_count_once_and_yield_to_the_application_connection(self):
        from report import accounting_totals
        totals = accounting_totals(sample('native', 'read'))
        self.assertEqual(totals['monitor'], 13)
        self.assertEqual(totals['tls'], 7)
        self.assertAlmostEqual(sum(totals.values()), 100)

    def test_discovery_and_topology_storage_are_separate_phases(self):
        from report import accounting_totals
        totals = accounting_totals(sample('ssm-uncached', 'write', two_connections=True))
        self.assertEqual(totals['discovery'], 3)
        self.assertEqual(totals['topologyStore'], 4)


class SetupEstimateTest(unittest.TestCase):
    def test_setup_is_split_in_historical_proportions(self):
        from report import setup_estimates
        native = dict(setup_estimates('native', 40))
        cached = dict(setup_estimates('ssm', 40))
        self.assertAlmostEqual(sum(native.values()), 40)
        self.assertAlmostEqual(sum(cached.values()), 40)
        self.assertGreater(native['dns'], 0)
        self.assertNotIn('dns', cached)
        self.assertIn('noMonitoring', cached)
        self.assertNotIn('noMonitoring', native)


class SummaryTest(unittest.TestCase):
    def test_summary_reports_statistics_phases_and_write_landings(self):
        from report import summarize
        summary = summarize(run(count=4, totals={('ssm', 'read'): 70.0}))
        cached = summary['operations']['read']['ssm']
        self.assertEqual(cached['count'], 4)
        self.assertEqual(cached['medianMs'], 70)
        self.assertAlmostEqual(sum(cached['phaseMeansMs'].values()), cached['meanMs'])
        self.assertEqual(summary['writeLandings']['oneConnection']['count'], 2)
        self.assertEqual(summary['writeLandings']['twoConnections']['count'], 2)

    def test_summary_rejects_incomplete_or_failed_runs(self):
        from report import summarize
        failed = run(count=2)
        failed['failures'] = [{'name': 'Error', 'message': 'x'}]
        with self.assertRaises(ValueError):
            summarize(failed)
        short = run(count=2)
        short['samples'].pop()
        with self.assertRaises(ValueError):
            summarize(short)


class RowTest(unittest.TestCase):
    def test_native_rows_are_one_per_member_with_the_operation_after_its_monitor(self):
        from report import member_rows
        members = ['member-1', 'member-2', 'member-3']
        rows = member_rows(sample('native', 'read'), members)
        self.assertEqual([row['member'] for row in rows], members)
        serving = rows[0]
        phases = [phase for phase, _, _ in serving['spans']]
        self.assertTrue(serving['operation'])
        self.assertLess(phases.index('monitor'), phases.index('tls'))
        self.assertIn('checkout', phases)
        self.assertIn('other', phases)
        self.assertEqual({phase for phase, _, _ in rows[1]['spans']}, {'monitor'})

    def test_the_operation_row_has_no_gaps_after_setup(self):
        from report import member_rows
        for variant in ('native', 'no-plugin', 'ssm'):
            rows = member_rows(sample(variant, 'read'), ['member-1', 'member-2', 'member-3'])
            spans = sorted((left, right) for _, left, right in next(row for row in rows if row['operation'])['spans'])
            self.assertEqual(spans[0][0], 10, variant)
            self.assertEqual(spans[-1][1], 100, variant)
            for (_, previous_end), (start, _) in zip(spans, spans[1:]):
                self.assertLessEqual(start, previous_end, variant)
        # Another member's monitor finishing later leaves the serving member waiting.
        slow = sample('native', 'read')
        slow['trace']['sockets'][1]['hello'] = [1020, 1028]
        native = member_rows(slow, ['member-1', 'member-2', 'member-3'])[0]
        self.assertIn(('waiting', 23, 25), native['spans'])

    def test_a_checkout_is_drawn_on_the_member_it_waited_for(self):
        from report import member_rows
        discovered = sample('no-plugin', 'write', two_connections=True)
        # The discovery command's checkout, after member-2's connection is ready.
        discovered['trace']['checkouts'].append({'address': 'member-2:27017', 'start': 1030.25, 'end': 1030.5})
        operation_row, first_row = member_rows(discovered, ['member-1', 'member-2'])
        self.assertIn(('checkout', 30.25, 30.5), first_row['spans'])
        self.assertNotIn(('checkout', 30.25, 30.5), operation_row['spans'])

    def test_only_contacted_members_get_a_row(self):
        from report import contacted_members
        members = ['member-1', 'member-2', 'member-3']
        self.assertEqual(contacted_members(sample('native', 'read'), members), members)
        self.assertEqual(contacted_members(sample('ssm', 'read'), members), ['member-1'])
        # The seed connection comes first, then the member that serves the operation.
        self.assertEqual(contacted_members(sample('no-plugin', 'write', two_connections=True), members), ['member-2', 'member-1'])


CASES = ['read-native', 'read-no-plugin', 'read-ssm', 'read-ssm-uncached', 'write-native',
         'write-no-plugin-1-connection', 'write-no-plugin-2-connections', 'write-ssm', 'write-ssm-uncached']


class LoadTest(unittest.TestCase):
    def test_samples_load_from_plain_or_gzipped_json(self):
        import gzip, json
        from report import load
        data = run(count=1)
        with tempfile.TemporaryDirectory() as directory:
            plain, packed = Path(directory) / 'samples.json', Path(directory) / 'samples.json.gz'
            plain.write_text(json.dumps(data))
            packed.write_bytes(gzip.compress(json.dumps(data).encode()))
            self.assertEqual(load(plain), load(packed))


class RenderTest(unittest.TestCase):
    def test_render_writes_one_image_per_case(self):
        from report import render, summarize
        data = run(count=2)
        with tempfile.TemporaryDirectory() as directory:
            render(data, summarize(data), Path(directory))
            self.assertEqual(sorted(p.stem for p in Path(directory).glob('*.png')), sorted(CASES))
            for path in Path(directory).glob('*.png'):
                self.assertGreater(path.stat().st_size, 10_000)

    def test_results_link_every_case_image_and_list_setup_estimates(self):
        from report import markdown, summarize
        text = markdown(summarize(run(count=2)))
        self.assertIn('| read / Native MongoDB | 2 |', text)
        self.assertIn('SRV + TXT DNS', text)
        self.assertIn('~', text)
        for case in CASES:
            self.assertIn(f'({case}.png)', text)


if __name__ == '__main__':
    unittest.main()
