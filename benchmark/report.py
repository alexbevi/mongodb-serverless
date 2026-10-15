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
from matplotlib.patches import Patch, PathPatch
from matplotlib.path import Path as PlotPath

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


def draw_connection(axis, connection, y):
    application = connection["kind"] == "application"
    axis.barh(
        y,
        connection["end"] - connection["start"],
        left=connection["start"],
        height=0.4,
        color="#e2e8f0",
        edgecolor="#334155" if application else "#7c3aed",
        linewidth=1.5,
        zorder=2,
    )
    for phase, (begin, end) in connection["phases"].items():
        if phase in COLORS:
            axis.barh(
                y, end - begin, left=begin, height=0.36, color=COLORS[phase], zorder=3
            )


def draw_command(axis, timeline, y):
    for phase, (begin, end) in timeline["command"].items():
        axis.barh(y, end - begin, left=begin, height=0.4, color=COLORS[phase], zorder=4)
    axis.text(
        timeline["total"] * 1.015,
        y,
        f"{timeline['total']:.1f} ms",
        va="center",
        fontsize=10,
        weight="bold",
    )


def draw_node_lanes(axis, native, serverless, member_letters):
    timeline = native["timeline"]
    connections = timeline["connections"]
    roles = {connection["host"]: connection["role"] for connection in connections}
    primary = next(host for host, role in roles.items() if role == "PRIMARY")
    secondaries = sorted(host for host in roles if host != primary)
    hosts = [secondaries[0], primary, secondaries[1]]
    lanes = dict(zip(hosts, [3.2, 2.2, 1.2]))
    applications = [c for c in connections if c["kind"] == "application"]
    selected = next(c for c in reversed(applications) if c["selected"])
    axis.barh(
        lanes[selected["host"]],
        timeline["total"],
        height=0.4,
        color="#e2e8f0",
        zorder=1,
    )
    totalmax = max(timeline["total"], serverless["timeline"]["total"])
    for connection in connections:
        y = lanes[connection["host"]]
        draw_connection(axis, connection, y)
        label = "monitor"
        if connection["kind"] == "application":
            label = "selected → " + (
                native["operation"] if connection is selected else "connect()"
            )
        axis.text(
            (connection["start"] + connection["end"]) / 2,
            y + 0.29,
            label,
            ha="center",
            fontsize=8.5,
            color="#334155",
        )
    for connection in applications:
        x = connection["start"]
        y = lanes[connection["host"]]
        width = totalmax * 0.025
        left, middle = x - width * 0.65, x - width * 0.32
        vertices = [
            (left, 3.6),
            (middle, 3.6),
            (middle, y + 0.13),
            (x, y),
            (middle, y - 0.13),
            (middle, 0.8),
            (left, 0.8),
        ]
        axis.add_patch(
            PathPatch(
                PlotPath(vertices, [PlotPath.MOVETO] + [PlotPath.CURVE4] * 6),
                fill=False,
                lw=1,
                color="#0f172a",
                zorder=5,
            )
        )
    draw_command(axis, timeline, lanes[selected["host"]])
    first = min(connection["start"] for connection in connections)
    axis.axvspan(0, first, ymin=0.31, ymax=0.94, color="#94a3b8", alpha=0.32, zorder=0)
    axis.axhline(0.35, color="#cbd5e1", lw=1)
    direct = serverless["timeline"]
    axis.barh(-0.55, direct["total"], height=0.4, color="#e2e8f0", zorder=0)
    axis.barh(
        -0.55,
        min(c["start"] for c in direct["connections"]),
        height=0.4,
        color="#94a3b8",
    )
    for connection in direct["connections"]:
        draw_connection(axis, connection, -0.55)
        axis.text(
            (connection["start"] + connection["end"]) / 2,
            -0.23,
            "direct application connection",
            ha="center",
            fontsize=9,
        )
    draw_command(axis, direct, -0.55)
    direct_host = direct["connections"][0]["host"]
    labels = [
        f"MongoDB {roles[host].capitalize()} {member_letters[host]}" for host in hosts
    ]
    labels.append(
        f"Serverless {serverless['servedRole'].capitalize()} {member_letters[direct_host]}"
    )
    axis.set_yticks([3.2, 2.2, 1.2, -0.55], labels, fontsize=10)
    for label in axis.get_yticklabels():
        if "Primary" in label.get_text():
            label.set_fontweight("bold")
    axis.set_ylim(-1.2, 4)


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
    member_letters = {
        host: chr(65 + index)
        for index, host in enumerate(
            sorted({c["host"] for row in rows for c in row["timeline"]["connections"]})
        )
    }
    figure, axes = plt.subplots(1, 2, figsize=(22, 8))
    figure.subplots_adjust(left=0.12, right=0.97, top=0.76, bottom=0.22, wspace=0.42)
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
        0.89,
        f"Measured {date}. Individual traces nearest cohort medians; headings report all-sample means.",
        ha="center",
        fontsize=11,
    )
    if environment == "aws":
        figure.text(
            0.5,
            0.85,
            "Point-in-time snapshot; not a statement of current performance.",
            ha="center",
            fontsize=11,
        )
    for axis, operation in zip(axes, ("read", "write")):
        native = representatives[operation, "native-cluster"]
        serverless = representatives[operation, "serverless"]
        draw_node_lanes(axis, native, serverless, member_letters)
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
        bbox_to_anchor=(0.5, 0.09),
        ncol=8,
        frameon=False,
    )
    figure.text(
        0.5,
        0.045,
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
