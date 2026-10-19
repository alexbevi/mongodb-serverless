import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('compact', Path(__file__).parents[1] / 'compact.py')
compact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compact)


class TraceCodecTest(unittest.TestCase):
    def test_column_encoding_preserves_every_diagnostic_value(self):
        trace = dict(execution=dict(start=1.123456789, end=9.87654321, threadCpuMs=2.2, segments=[
            dict(kind='callback', resource='PROMISE', sourceId=0, start=1.123456789, end=4.2, threadCpuMs=2.2),
            dict(kind='dispatch', resource='TCPWRAP', sourceId=1, start=4.2, end=9.87654321, threadCpuMs=0)]),
            activities=[dict(name='URI parsing', kind='sync', start=1.2, end=2.3, threadCpuMs=.8),
                        dict(name='Plugin read', kind='async', start=2.4, end=8.3)])
        data = dict(samples=[dict(trace=trace)], executionSources=['first stack', 'second stack'])
        original = copy.deepcopy(data)
        compact.compact_diagnostics(data)
        self.assertIsInstance(data['samples'][0]['trace']['execution']['segments'][0], list)
        compact.compact_diagnostics(data)
        compact.expand_diagnostics(data)
        self.assertEqual(data, original)
        compact.expand_diagnostics(data)
        self.assertEqual(data, original)
