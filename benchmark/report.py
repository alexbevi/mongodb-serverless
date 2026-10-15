#!/usr/bin/env python3
"""Render one environment's measured connection traces and summary statistics."""

import argparse
from collections import Counter
import json
import math
from pathlib import Path
from statistics import mean, median

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

COLORS = {
    "tcp": "#2563eb",
    "tls": "#38bdf8",
    "hello": "#a78bfa",
    "auth": "#f59e0b",
    "send": "#ef4444",
    "receive": "#10b981",
}
MODES = ("native-cluster", "serverless")


def local_samples(data):
    rows = []
    for sample in data["samples"]:
        if sample["variant"] not in ("native", "serverless-no-monitoring"):
            continue
        trace = sample["trace"]
        start = trace["start"]
        command = trace["command"]
        connections = []
        for socket in trace["sockets"]:
            phases = {
                phase: [value - start for value in socket[phase]]
                for phase in ("tcp", "tls", "hello", "auth")
                if phase in socket
            }
            connections.append(
                {
                    "host": socket["host"],
                    "role": socket.get("role", "UNKNOWN"),
                    "kind": "application" if "auth" in socket else "monitor",
                    "selected": socket["host"] == command["socket"]["host"],
                    "start": socket["start"] - start,
                    "end": max(
                        (interval[1] for interval in phases.values()),
                        default=sample["timings"]["total"],
                    ),
                    "phases": phases,
                }
            )
        rows.append(
            {
                "mode": "native-cluster"
                if sample["variant"] == "native"
                else "serverless",
                "operation": sample["operation"],
                "servedRole": sample["servedRole"],
                "timeline": {
                    "total": sample["timings"]["total"],
                    "connections": connections,
                    "command": {
                        "send": [command["start"] - start, command["sent"] - start],
                        "receive": [command["sent"] - start, command["end"] - start],
                    },
                },
            }
        )
    return rows


def summarize(rows):
    result = []
    for operation in ("read", "write"):
        for mode in MODES:
            group = [
                row
                for row in rows
                if (row["operation"], row["mode"]) == (operation, mode)
            ]
            if not group:
                raise ValueError(
                    f"Missing {operation} samples for {mode}; local runs need --no-monitoring"
                )
            totals = sorted(row["timeline"]["total"] for row in group)
            if any(not math.isfinite(value) or value <= 0 for value in totals):
                raise ValueError("Sample durations must be finite and positive")
            result.append(
                {
                    "operation": operation,
                    "driver": mode,
                    "n": len(group),
                    "mean": mean(totals),
                    "median": median(totals),
                    "p95": totals[math.ceil(0.95 * len(totals)) - 1],
                    "roles": dict(Counter(row["servedRole"] for row in group)),
                    "sockets": dict(
                        Counter(len(row["timeline"]["connections"]) for row in group)
                    ),
                }
            )
    return result


def draw_trace(axis, row, base, label):
    timeline = row["timeline"]
    connections = timeline["connections"]
    first = min(connection["start"] for connection in connections)
    total = timeline["total"]
    ticks = []
    labels = []
    for index, connection in enumerate(connections):
        y = base - index
        ticks.append(y)
        role = connection["role"].capitalize()
        kind = connection["kind"]
        labels.append(f"{label}\n{connection['host']} · {role}\n{kind}")
        axis.barh(y, total, height=0.45, color="#e2e8f0", alpha=0.45)
        axis.barh(y, first, height=0.45, color="#94a3b8")
        axis.barh(
            y,
            connection["end"] - connection["start"],
            left=connection["start"],
            height=0.45,
            color="#e2e8f0",
            edgecolor="#334155" if kind == "application" else "#7c3aed",
        )
        for phase, (begin, end) in connection["phases"].items():
            if phase in COLORS:
                axis.barh(y, end - begin, left=begin, height=0.4, color=COLORS[phase])
        if kind == "application" and connection["selected"]:
            for phase, (begin, end) in timeline["command"].items():
                axis.barh(y, end - begin, left=begin, height=0.45, color=COLORS[phase])
            axis.text(
                total * 1.015,
                y,
                f"{total:.1f} ms",
                va="center",
                fontsize=10,
                weight="bold",
            )
    return ticks, labels


def render(data, environment, output):
    rows = local_samples(data) if environment == "local" else data["samples"]
    summary = summarize(rows)
    representatives = {}
    for operation in ("read", "write"):
        for mode in MODES:
            group = [
                row
                for row in rows
                if (row["operation"], row["mode"]) == (operation, mode)
            ]
            middle = median(row["timeline"]["total"] for row in group)
            representatives[operation, mode] = min(
                group, key=lambda row: abs(row["timeline"]["total"] - middle)
            )
    figure, axes = plt.subplots(2, 1, figsize=(15, 13))
    figure.subplots_adjust(left=0.25, right=0.94, top=0.86, bottom=0.12, hspace=0.45)
    label = "Local Docker" if environment == "local" else "AWS Lambda"
    date = data.get("createdAt", data.get("recordedAt", ""))[:10]
    figure.suptitle(
        f"{label} · replica-set discovery and direct connections",
        fontsize=20,
        weight="bold",
        y=0.97,
    )
    figure.text(
        0.5,
        0.935,
        f"Measured {date}. Individual traces nearest cohort medians; headings report all-sample means.",
        ha="center",
        fontsize=11,
    )
    if environment == "aws":
        figure.text(
            0.5,
            0.91,
            "Point-in-time snapshot; not a statement of current performance.",
            ha="center",
            fontsize=11,
        )
    for axis, operation in zip(axes, ("read", "write")):
        native = representatives[operation, "native-cluster"]
        serverless = representatives[operation, "serverless"]
        ticks, labels = draw_trace(axis, native, 0, "MongoDB")
        base = -len(native["timeline"]["connections"]) - 1
        more_ticks, more_labels = draw_trace(axis, serverless, base, "Serverless")
        axis.set_yticks(ticks + more_ticks, labels + more_labels, fontsize=8)
        means = {
            item["driver"]: item["mean"]
            for item in summary
            if item["operation"] == operation
        }
        reduction = 100 * (1 - means["serverless"] / means["native-cluster"])
        axis.set_title(
            f"{operation.title()} · mean {means['native-cluster']:.1f} → {means['serverless']:.1f} ms ({reduction:.1f}% less time)",
            loc="left",
            fontsize=15,
            weight="bold",
            pad=15,
        )
        axis.set_xlim(
            0, max(native["timeline"]["total"], serverless["timeline"]["total"]) * 1.15
        )
        axis.set_xlabel("Milliseconds since client construction")
        axis.grid(axis="x", alpha=0.15)
        axis.set_axisbelow(True)
        axis.spines[["top", "right", "left"]].set_visible(False)
    figure.legend(
        handles=[
            Patch(
                facecolor=color,
                label=phase.upper() if phase in ("tcp", "tls") else phase.capitalize(),
            )
            for phase, color in COLORS.items()
        ]
        + [
            Patch(facecolor="#94a3b8", label="Before first socket"),
            Patch(facecolor="#e2e8f0", label="Other / gaps"),
        ],
        loc="lower center",
        bbox_to_anchor=(0.5, 0.055),
        ncol=8,
        frameon=False,
    )
    figure.text(
        0.5,
        0.025,
        "Every socket in each illustrated sample is shown. Watcher work, imports, client close and Lambda INIT are excluded.",
        ha="center",
        fontsize=10,
    )
    output.mkdir(parents=True, exist_ok=True)
    figure.savefig(output / "latency.png", dpi=160, facecolor="white")
    plt.close(figure)
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path)
    parser.add_argument("--environment", choices=("local", "aws"), required=True)
    parser.add_argument("--output-dir", type=Path)
    arguments = parser.parse_args()
    render(
        json.loads(arguments.samples.read_text()),
        arguments.environment,
        arguments.output_dir or arguments.samples.parent,
    )
