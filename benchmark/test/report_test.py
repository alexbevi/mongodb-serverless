from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest


class ReportTest(unittest.TestCase):
    def test_accounting_covers_every_millisecond_without_adding_parallel_work(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("report", Path(__file__).parents[1] / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        timeline = {
            "total": 20,
            "dns": [{"start": 2, "end": 5}, {"start": 3, "end": 4}],
            "connections": [
                {"kind": "monitor", "selected": True, "start": 5,
                 "phases": {"tcp": [5, 7], "tls": [7, 10]}},
                {"kind": "application", "selected": True, "start": 10,
                 "phases": {"tcp": [10, 12], "tls": [12, 14]}},
            ],
            "gaps": [{"phase": "poolGaps", "start": 9, "end": 15}],
            "command": {"send": [15, 16], "receive": [16, 19]},
        }
        segments = report.accounting_segments(timeline)
        self.assertEqual(segments[0]["start"], 0)
        self.assertEqual(segments[-1]["end"], 20)
        for left, right in zip(segments, segments[1:]):
            self.assertEqual(left["end"], right["start"])
        totals = report.accounting_totals(timeline)
        self.assertEqual(sum(totals.values()), 20)
        self.assertEqual(totals["clusterDns"], 3)
        self.assertEqual(totals["tcp"], 2)
        self.assertEqual(totals["poolGaps"], 1)
        self.assertEqual(totals["monitor"], 5)
        self.assertEqual(totals["beforeSocket"], 2)
        self.assertEqual(totals["unattributed"], 1)

    def test_dns_intervals_remain_separate_and_parallel_queries_are_not_added(self):
        import importlib.util
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        data = json.loads((root / "results/local/samples.json").read_text())
        sample = next(s for s in data["samples"] if s["variant"] == "native")
        start = sample["trace"]["start"]
        sample["trace"]["dns"] = [
            {"kind": "SRV", "start": start + 1, "end": start + 6},
            {"kind": "TXT", "start": start + 2, "end": start + 4},
        ]
        row = report.local_samples({"samples": [sample]})[0]
        self.assertEqual(row["timeline"]["dns"], [
            {"kind": "SRV", "start": 1, "end": 6},
            {"kind": "TXT", "start": 2, "end": 4},
        ])
        self.assertEqual(row["dnsDurations"]["SRV"], 5)
        self.assertEqual(row["dnsDurations"]["TXT"], 2)
        self.assertEqual(row["dnsDurations"]["seedlistWall"], 5)

    def test_cluster_dns_spans_all_node_lanes_without_extra_rows(self):
        import importlib.util
        from unittest.mock import patch
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        data = json.loads((root / "results/aws/samples.json").read_text())
        for sample in data["samples"]:
            sample["timeline"]["dns"] = [
                {"kind": "SRV", "start": 1, "end": 4},
                {"kind": "TXT", "start": 2, "end": 3},
            ] if sample["mode"] == "native-cluster" else []
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(report.plt, "close") as close:
                report.render(data, "aws", Path(directory))
            figure = close.call_args.args[0]
            for axis in figure.axes:
                self.assertEqual(axis.get_ylim(), (-1.2, 4))
                segments = [p for p in axis.patches if p.get_gid() == "cluster-dns"]
                self.assertEqual(len(segments), 1)
                self.assertEqual(segments[0].get_x(), 1)
                self.assertEqual(segments[0].get_width(), 3)
                self.assertAlmostEqual(segments[0].get_y(), 1.0)
                self.assertAlmostEqual(segments[0].get_height(), 2.4)
                self.assertFalse(any("SRV DNS" in t.get_text() or "TXT DNS" in t.get_text() for t in axis.texts))
            report.plt.close(figure)

    def test_lifecycle_colours_only_unmeasured_gaps_without_double_counting(self):
        import importlib.util

        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        sample = {
            "trace": {
                "start": 100,
                "end": 125,
                "command": {
                    "start": 117, "end": 124,
                    "socket": {"tcp": [104, 106], "tls": [106, 109],
                               "hello": [110, 112], "auth": [112, 114]},
                },
                "lifecycle": {
                    "connectionSetup": [103, 115], "checkouts": [[102, 116]],
                    "readyToCommand": [115, 118], "command": [118, 123],
                    "afterCommand": [123, 125],
                },
            }
        }
        gaps = report.event_gap_segments(sample)
        self.assertEqual(gaps, [
            {"phase": "poolGaps", "start": 3, "end": 4},
            {"phase": "poolGaps", "start": 9, "end": 10},
            {"phase": "poolGaps", "start": 14, "end": 15},
            {"phase": "poolGaps", "start": 2, "end": 3},
            {"phase": "poolGaps", "start": 15, "end": 16},
            {"phase": "beforeCommand", "start": 16, "end": 17},
            {"phase": "afterReply", "start": 24, "end": 25},
        ])
        self.assertEqual(sum(gap["end"] - gap["start"] for gap in gaps), 7)

    def test_node_lanes_show_selection_braces_and_bold_primary_labels(self):
        import importlib.util
        from unittest.mock import patch
        from matplotlib.patches import PathPatch

        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        data = json.loads((root / "results/aws/samples.json").read_text())
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(report.plt, "close") as close:
                report.render(data, "aws", Path(directory))
            figure = close.call_args.args[0]
            for axis in figure.axes:
                labels = axis.get_yticklabels()
                self.assertEqual(len(labels), 4)
                self.assertEqual(
                    [label.get_text() for label in labels[:3]],
                    ["MongoDB Secondary A", "MongoDB Primary B", "MongoDB Secondary C"],
                )
                self.assertEqual(labels[1].get_fontweight(), "bold")
                braces = [item for item in axis.patches if isinstance(item, PathPatch)]
                operation = "read" if axis is figure.axes[0] else "write"
                group = [
                    row
                    for row in data["samples"]
                    if row["mode"] == "native-cluster" and row["operation"] == operation
                ]
                middle = report.median(row["timeline"]["total"] for row in group)
                sample = min(
                    group, key=lambda row: abs(row["timeline"]["total"] - middle)
                )
                applications = [
                    c
                    for c in sample["timeline"]["connections"]
                    if c["kind"] == "application"
                ]
                self.assertEqual(len(braces), len(applications))
                for brace, connection in zip(braces, applications):
                    self.assertAlmostEqual(
                        brace.get_path().vertices[3][0], connection["start"]
                    )
            report.plt.close(figure)

    def test_local_refresh_is_independent_of_the_aws_snapshot(self):
        root = Path(__file__).parents[1]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            aws = output / "aws"
            aws.mkdir()
            snapshot = aws / "results.md"
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
            samples = json.loads((root / "results/local/samples.json").read_text())
            totals = [
                sample["timings"]["total"]
                for sample in samples["samples"]
                if sample["variant"] == "native" and sample["operation"] == "read"
            ]
            self.assertAlmostEqual(read["mean"], sum(totals) / len(totals))
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
            data = json.loads((root / "results/aws/samples.json").read_text())
            totals = [s["phases"]["total"] for s in data["samples"]
                      if s["mode"] == "native-cluster" and s["operation"] == "read"]
            self.assertAlmostEqual(read["mean"], sum(totals) / len(totals))
            self.assertEqual(snapshot.read_text(), "Historical AWS snapshot\n")
            self.assertFalse(list(output.rglob("*.svg")))
            evidence = (root / "results/aws/samples.json").read_text()
            self.assertNotIn(".mongodb.net", evidence)
            self.assertNotRegex(evidence, r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
            for key in ["requestId", "roundId", "environmentId"]:
                self.assertNotIn(key, evidence)


if __name__ == "__main__":
    unittest.main()
