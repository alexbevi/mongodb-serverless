from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest


class ReportTest(unittest.TestCase):
    def test_local_refresh_is_independent_of_the_aws_snapshot(self):
        root = Path(__file__).parents[1]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            aws = output / "aws"
            aws.mkdir()
            snapshot = aws / "sample-10-2026.md"
            snapshot.write_text("Historical AWS snapshot\n")
            before = hashlib.sha256(snapshot.read_bytes()).hexdigest()
            subprocess.run(
                [
                    sys.executable,
                    str(root / "report.py"),
                    str(root / "results/local/samples.json"),
                    "--environment",
                    "local",
                    "--output-dir",
                    str(output / "local"),
                ],
                check=True,
                capture_output=True,
            )
            self.assertEqual(hashlib.sha256(snapshot.read_bytes()).hexdigest(), before)
            self.assertEqual(
                {p.name for p in (output / "local").iterdir()},
                {"latency.png", "summary.json"},
            )
            summary = json.loads((output / "local/summary.json").read_text())
            self.assertEqual(len(summary), 4)
            read = next(
                s
                for s in summary
                if s["driver"] == "native-cluster" and s["operation"] == "read"
            )
            self.assertEqual(read["n"], 48)
            self.assertAlmostEqual(read["mean"], 48.2, delta=0.05)
            self.assertEqual(sum(read["sockets"].values()), 48)
            self.assertTrue(
                (output / "local/latency.png").read_bytes().startswith(b"\x89PNG")
            )
            subprocess.run(
                [
                    sys.executable,
                    str(root / "report.py"),
                    str(root / "results/aws/samples.json"),
                    "--environment",
                    "aws",
                    "--output-dir",
                    str(aws),
                ],
                check=True,
                capture_output=True,
            )
            summary = json.loads((aws / "summary.json").read_text())
            read = next(
                s
                for s in summary
                if s["driver"] == "native-cluster" and s["operation"] == "read"
            )
            self.assertEqual(read["n"], 30)
            self.assertAlmostEqual(read["mean"], 290.3, delta=0.05)
            self.assertEqual(snapshot.read_text(), "Historical AWS snapshot\n")
            self.assertFalse(list(output.rglob("*.svg")))
            evidence = (root / "results/aws/samples.json").read_text()
            self.assertNotIn(".mongodb.net", evidence)
            self.assertNotRegex(evidence, r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
            for key in ["requestId", "roundId", "environmentId"]:
                self.assertNotIn(key, evidence)


if __name__ == "__main__":
    unittest.main()
