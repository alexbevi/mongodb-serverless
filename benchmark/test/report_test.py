from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest


class ReportTest(unittest.TestCase):
    def test_chart_heading_uses_median_reduction_on_one_line(self):
        import importlib.util
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        rows = [{"operation": operation, "mode": mode, "servedRole": "PRIMARY",
                 "timeline": {"total": value, "connections": []}}
                for operation in ("read", "write") for mode in report.MODES for value in (1, 2, 3)]
        stats = report.summarize(rows)[0]
        self.assertEqual(stats["standardDeviation"], 1)
        self.assertEqual(stats["coefficientOfVariationPercent"], 50)
        native = {"median": 250, "mean": 300, "standardDeviation": 30, "coefficientOfVariationPercent": 10}
        direct = {"median": 200, "mean": 270, "standardDeviation": 27, "coefficientOfVariationPercent": 10}
        self.assertEqual(report.chart_heading("read", native, direct),
                         "Read · median ~250.0→~200.0 ms (20.0% less) · mean ~300.0→~270.0 · SD ~30.0→~27.0 · CV 10.0→10.0%")

    def test_callback_legend_names_measured_work_and_keeps_probe_overhead(self):
        import importlib.util
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        data = {"callbackProfile": {"stacks": [
            {"group": "Setup", "samples": 50, "stack": [
                {"function": "isIPv6", "url": "node:internal/net"},
                {"function": "parseSslOptions", "url": "/mongodb/lib/cmap/connect.js"}]},
            {"group": "Setup", "samples": 20, "stack": [
                {"function": "defaultPrepareStackTrace", "url": "node:internal/errors"},
                {"function": "init", "url": "/benchmark/dist/execution.js"},
                {"function": "Server", "url": "/mongodb/lib/sdam/server.js"}]},
            {"group": "Operation", "samples": 100, "stack": [
                {"function": "command", "url": "/mongodb/lib/sdam/server.js"}]}]}}
        self.assertEqual(report.callback_legend(data, "Setup"),
                         "Callbacks (IP validation, tracing overhead)")
        self.assertEqual(report.callback_legend(data, "Connection"), "Callbacks (not sampled)")
        self.assertEqual(report.callback_legend({}, "Setup"), "Callbacks (not sampled)")

    def test_cpu_annotation_omits_zero_throttling(self):
        import importlib.util
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        self.assertEqual(report.cpu_annotation({"threadCpuMs": 29.2, "throttledMs": 0}), "Main-thread CPU ~29.2 ms")
        self.assertNotIn("throttled", report.cpu_annotation({"threadCpuMs": 29.2, "throttledMs": 0.01}))
        self.assertIn("throttled ~12.3 ms", report.cpu_annotation({"threadCpuMs": 29.2, "throttledMs": 12.3}))

    def test_execution_stack_compaction_preserves_sources(self):
        import importlib.util
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("compact", root / "compact.py")
        compact = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(compact)
        data = {"samples": [{"trace": {"execution": {"segments": [
            {"source": "first stack", "start": 1}, {"source": "first stack", "start": 2},
            {"source": "second stack", "start": 3}]}}}]}
        compact.compact_sources(data)
        self.assertEqual(data["executionSources"], ["first stack", "second stack"])
        segments = data["samples"][0]["trace"]["execution"]["segments"]
        self.assertEqual([s["sourceId"] for s in segments], [0, 0, 1])
        self.assertEqual([s["start"] for s in segments], [1, 2, 3])
        compact.compact_sources(data)
        self.assertEqual(data["executionSources"], ["first stack", "second stack"])

    def test_comparison_resamples_paired_blocks_and_reports_batch_variation(self):
        import importlib.util
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        rows = [{"mode": mode, "block": [batch, iteration], "batch": batch,
                 "timeline": {"total": duration}}
                for batch in (1, 2) for iteration in range(3)
                for mode, duration in (("native-cluster", 10 + iteration), ("serverless", (10 + iteration) / 2))]
        stats = report.comparison_stats(rows)
        self.assertEqual(stats["blocks"], 6)
        self.assertEqual(stats["reductionPercent"], 50)
        self.assertEqual(stats["confidence95Percent"], [50, 50])
        self.assertEqual([batch["reductionPercent"] for batch in stats["batches"]], [50, 50])
        with self.assertRaisesRegex(ValueError, "paired"):
            report.comparison_stats(rows[:-1])

    def test_run_caption_reports_iterations_location_and_hardware(self):
        import importlib.util
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        local = json.loads((root / "results/local/samples.json").read_text())
        local["environment"]["host"] = {"cpu": "Apple M4 Max", "memoryBytes": 64 * 1024**3}
        local["samples"] = [{"variant": mode, "operation": operation}
                            for mode in ("native", "serverless", "serverless-no-monitoring")
                            for operation in ("read", "write") for _ in range(100)]
        local["runDurationSeconds"] = 125
        local["batches"] = [1, 2, 3, 4]
        caption = report.run_caption(local, "local")
        for expected in ("100 iterations per driver/operation", "600 total", "elapsed ~2m 05s", "4 batches", "Local host", "Apple M4 Max", "64 GiB", "1 GiB", "no CPU quota"):
            self.assertIn(expected, caption)
        aws = json.loads((root / "results/aws/samples.json").read_text())
        aws["architecture"] = "arm64"
        aws["samples"] = [{"mode": mode, "operation": operation}
                          for mode in ("native-cluster", "serverless")
                          for operation in ("read", "write") for _ in range(120)]
        caption = report.run_caption(aws, "aws")
        for expected in ("120 iterations per driver/operation", "480 total", "ap-southeast-2", "ARM64", "1024 MB"):
            self.assertIn(expected, caption)

    def test_local_diagram_uses_one_measured_cohort_with_percentage_headings(self):
        import importlib.util
        from unittest.mock import patch
        root = Path(__file__).parents[1]
        data = json.loads((root / "results/local/samples.json").read_text())
        cohort = data.get("diagnostic", data)
        spec = importlib.util.spec_from_file_location("report", root / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(report.plt, "close") as close:
                report.render(cohort, "local", Path(directory))
            for axis in close.call_args.args[0].axes:
                self.assertIn("% less)", axis.get_title(loc="left"))
                self.assertNotIn("\n", axis.get_title(loc="left"))
        self.assertTrue(data["configuration"]["diagnostics"])
        self.assertGreaterEqual(data["configuration"]["count"], 100)
        self.assertNotIn("diagnostic", data)
        self.assertEqual(data["environment"]["cpuMax"].split()[0], "max")
        for sample in data["samples"]:
            trace = sample["trace"]
            self.assertEqual(trace["execution"]["start"], trace["start"])
            self.assertEqual(trace["execution"]["end"], trace["end"])
            self.assertTrue(trace["activities"])

    def test_legend_order_follows_first_appearance_within_each_stage(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("report", Path(__file__).parents[1] / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        row = {"applicationConnectionReadyMs": 10, "timeline": {
            "total": 13, "dns": [{"start": 2, "end": 3}],
            "connections": [{"kind": "application", "selected": True, "start": 4, "end": 10,
                             "phases": {"lookup": [5, 6], "tcp": [6, 7], "tls": [7, 8], "auth": [8, 10]}}],
            "command": {"send": [11, 12], "receive": [12, 13]},
            "activities": [{"name": "Native URI/options parsing", "kind": "sync", "start": 0, "end": 2},
                           {"name": "TLS socket/context construction", "kind": "sync", "start": 4, "end": 5}],
            "execution": [{"kind": "callback", "start": 0, "end": 13}]}}
        self.assertEqual(report.legend_order([row], "Setup"),
                         ["code:Client & topology initialization", "clusterDns", "callback"])
        self.assertEqual(report.legend_order([row], "Connection")[:3],
                         ["code:TLS socket/context construction", "lookup", "tcp"])
        self.assertEqual(report.legend_order([row], "Operation"), ["callback", "send", "receive"])

    def test_setup_display_merges_adjacent_related_scopes_without_swallowing_waits(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("report", Path(__file__).parents[1] / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        raw = [
            {"phase": "code:Direct URI rewrite", "start": 0, "end": 1},
            {"phase": "code:Native URI/options parsing", "start": 1, "end": 3},
            {"phase": "code:Native client construction", "start": 3, "end": 4},
            {"phase": "dispatch", "start": 4, "end": 5},
            {"phase": "code:Topology construction", "start": 5, "end": 6},
        ]
        display = report.display_segments(raw)
        self.assertEqual(display, [
            {"phase": "code:Client & topology initialization", "start": 0, "end": 4},
            {"phase": "dispatch", "start": 4, "end": 5},
            {"phase": "code:Client & topology initialization", "start": 5, "end": 6},
        ])
        self.assertEqual(len(raw), 5)
        self.assertEqual(raw[0]["phase"], "code:Direct URI rewrite")
        self.assertEqual(report.phase_color(raw[0]["phase"]), report.phase_color(raw[1]["phase"]))

    def test_section_labels_use_connection_ready_and_group_the_legend(self):
        import importlib.util
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location("report", Path(__file__).parents[1] / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        row = {"applicationConnectionReadyMs": 18, "timeline": {
            "total": 25, "connections": [
                {"kind": "monitor", "selected": True, "start": 3, "end": 8},
                {"kind": "application", "selected": True, "start": 10, "end": 15}]}}
        sections = report.section_spans(row)
        self.assertEqual([(s["label"], s["start"], s["end"]) for s in sections], [
            ("Setup", 0, 3), ("Monitor Connection", 3, 8),
            ("Application Connection", 10, 18), ("Operation", 18, 25)])
        data = json.loads((Path(__file__).parents[1] / "results/aws/samples.json").read_text())
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(report.plt, "close") as close:
                report.render(data, "aws", Path(directory))
            figure = close.call_args.args[0]
            self.assertEqual([legend.get_title().get_text() for legend in figure.legends],
                             ["Setup", "Connection", "Operation"])
            for axis in figure.axes:
                self.assertTrue(any(t.get_text().startswith("Setup (") for t in axis.texts))
                self.assertTrue(any(t.get_text().startswith("Operation (") for t in axis.texts))
                self.assertEqual(len(axis.tables), 0)
            report.plt.close(figure)

    def test_diagnostic_accounting_uses_measured_code_and_execution_intervals(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("report", Path(__file__).parents[1] / "report.py")
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        timeline = {"total": 10, "dns": [], "gaps": [],
                    "connections": [{"kind": "application", "selected": True, "start": 4,
                                     "phases": {"tcp": [4, 6]}}],
                    "command": {"send": [8, 9], "receive": [9, 10]},
                    "activities": [{"name": "Native URI/options parsing", "kind": "sync", "start": 0, "end": 2}],
                    "execution": [{"kind": "callback", "resource": "HANDLER", "start": 0, "end": 4},
                                  {"kind": "dispatch", "resource": "TCPWRAP", "start": 4, "end": 8},
                                  {"kind": "callback", "resource": "TCPWRAP", "start": 8, "end": 10}]}
        totals = report.accounting_totals(timeline)
        self.assertEqual(totals["code:Native URI/options parsing"], 2)
        self.assertEqual(totals["callback"], 2)
        self.assertEqual(totals["dispatch"], 2)
        self.assertEqual(totals["beforeSocket"] + totals["unattributed"], 0)
        self.assertEqual(sum(totals.values()), 10)
        timeline["execution"] = []
        with self.assertRaisesRegex(ValueError, "Uncovered diagnostic interval"):
            report.accounting_segments(timeline)

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
        row = report.local_samples({**data, "samples": [sample]})[0]
        for actual, expected in zip(row["timeline"]["dns"], [
            {"kind": "SRV", "start": 1, "end": 6},
            {"kind": "TXT", "start": 2, "end": 4},
        ]):
            self.assertEqual(actual["kind"], expected["kind"])
            self.assertAlmostEqual(actual["start"], expected["start"])
            self.assertAlmostEqual(actual["end"], expected["end"])
        self.assertAlmostEqual(row["dnsDurations"]["SRV"], 5)
        self.assertAlmostEqual(row["dnsDurations"]["TXT"], 2)
        self.assertAlmostEqual(row["dnsDurations"]["seedlistWall"], 5)

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
            samples = json.loads((root / "results/local/samples.json").read_text())
            totals = [
                sample["timings"]["total"]
                for sample in samples["samples"]
                if sample["variant"] == "native" and sample["operation"] == "read"
            ]
            self.assertEqual(read["n"], len(totals))
            self.assertAlmostEqual(read["mean"], sum(totals) / len(totals))
            self.assertEqual(sum(read["sockets"].values()), len(totals))
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
            self.assertGreaterEqual(read["n"], 100)
            data = json.loads((root / "results/aws/samples.json").read_text())
            totals = [s["phases"]["total"] for s in data["samples"]
                      if s["mode"] == "native-cluster" and s["operation"] == "read"]
            self.assertEqual(read["n"], len(totals))
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
