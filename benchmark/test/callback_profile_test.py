import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))


class CallbackProfileTest(unittest.TestCase):
    def test_attributes_only_samples_inside_residual_callbacks(self):
        from callback_profile import sampled_callbacks
        capture = {"origin": 10, "profile": {"nodes": [
            {"id": 1, "callFrame": {"functionName": "onData", "url": "driver.js", "lineNumber": 9}},
            {"id": 2, "callFrame": {"functionName": "(idle)", "url": "", "lineNumber": -1}}],
            "samples": [1, 1, 2, 1], "timeDeltas": [1000, 1000, 1000, 1000]}}
        spans = [{"phase": "callback", "start": 0.5, "end": 1.5},
                 {"phase": "tls", "start": 1.5, "end": 2.5},
                 {"phase": "callback", "start": 2.5, "end": 3.5},
                 {"phase": "callback", "start": 3.5, "end": 4.5}]
        result = sampled_callbacks(capture, 10, spans, 1.5, 3.5)
        self.assertEqual([(r['group'], r['function'], r['samples']) for r in result],
                         [('Setup', 'onData', 1), ('Connection', '(idle)', 1), ('Operation', 'onData', 1)])
        self.assertEqual(result[0]['line'], 10)


if __name__ == '__main__':
    unittest.main()
