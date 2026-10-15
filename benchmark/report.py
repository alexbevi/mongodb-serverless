#!/usr/bin/env python3
"""Render one environment's measured connection traces and summary statistics."""

import argparse
import textwrap
from collections import Counter
import json
import math
import random
from pathlib import Path
from statistics import mean, median, stdev

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch, PathPatch
from matplotlib.path import Path as PlotPath

COLORS = {
    "clusterDns": "#4338ca",
    "lookup": "#854d0e",
    "tcp": "#2563eb",
    "tls": "#38bdf8",
    "hello": "#a78bfa",
    "auth": "#f59e0b",
    "send": "#ef4444",
    "receive": "#10b981",
}
MODES = ("native-cluster", "serverless")


GAP_COLORS = {
    "poolGaps": ("#c026d3", "Pool / checkout remainder"),
    "beforeCommand": ("#0e7490", "Ready → command remainder"),
    "afterReply": ("#fb7185", "After reply remainder"),
}


def event_gap_segments(sample):
    trace = sample["trace"]
    windows = trace.get("lifecycle")
    if not windows:
        return []
    command = trace["command"]
    socket = command["socket"]
    covered = [socket[phase] for phase in ("lookup", "tcp", "tls", "hello", "auth") if phase in socket]
    covered.append([command["start"], command["end"]])
    segments = []
    categories = [
        ("poolGaps", [windows["connectionSetup"], *windows["checkouts"]]),
        ("beforeCommand", [windows["readyToCommand"]]),
        ("afterReply", [windows["afterCommand"]]),
    ]
    for phase, intervals in categories:
        for begin, end in intervals:
            pieces = [(max(trace["start"], begin), min(trace["end"], end))]
            for left, right in covered:
                remaining = []
                for a, b in pieces:
                    if right <= a or left >= b:
                        remaining.append((a, b))
                    else:
                        if a < left:
                            remaining.append((a, left))
                        if right < b:
                            remaining.append((right, b))
                pieces = remaining
            for a, b in pieces:
                if b > a:
                    segments.append({"phase": phase, "start": a - trace["start"], "end": b - trace["start"]})
                    covered.append((a, b))
    return segments


PHASE_LABELS = {
    "clusterDns": "Cluster DNS (SRV + TXT union)",
    "lookup": "Application host DNS",
    "tcp": "Application TCP connect",
    "tls": "Application TLS handshake",
    "hello": "Application hello exchange",
    "auth": "Application authentication",
    "send": "Command start → socket write",
    "receive": "Socket write → reply received",
    "monitor": "Monitor DNS / TCP / TLS / hello (union)",
    "poolGaps": "Pool / checkout interval remainder",
    "beforeCommand": "Ready → command interval remainder",
    "afterReply": "Reply → handler return remainder",
    "beforeSocket": "Before first socket: cause unmeasured",
    "unattributed": "Between events: cause unmeasured",
}


def accounting_segments(timeline):
    total = timeline["total"]
    application = next(c for c in reversed(timeline["connections"])
                       if c["kind"] == "application" and c["selected"])
    first_socket = min(c["start"] for c in timeline["connections"])
    intervals = [(phase, *interval) for phase, interval in timeline["command"].items()]
    intervals += [(phase, *interval) for phase, interval in application["phases"].items()]
    intervals += [("clusterDns", q["start"], q["end"]) for q in timeline.get("dns", [])]
    intervals += [("monitor", *interval) for c in timeline["connections"]
                  if c["kind"] == "monitor" for interval in c["phases"].values()]
    diagnostic = "execution" in timeline
    if diagnostic:
        activities = sorted(timeline.get("activities", []),
                            key=lambda a: (a["kind"] != "sync", a["end"] - a["start"]))
        intervals += [("code:" + a["name"], a["start"], a["end"]) for a in activities]
        intervals += [(e["kind"], e["start"], e["end"]) for e in timeline["execution"]]
    else:
        intervals += [(g["phase"], g["start"], g["end"]) for g in timeline.get("gaps", [])]
        intervals.append(("beforeSocket", 0, first_socket))
    boundaries = sorted({0, total, *(max(0, min(total, t))
                                    for _, a, b in intervals for t in (a, b))})
    result = []
    for a, b in zip(boundaries, boundaries[1:]):
        phase = next((phase for phase, left, right in intervals if left <= a and b <= right),
                     "unattributed")
        if diagnostic and phase == "unattributed":
            raise ValueError(f"Uncovered diagnostic interval: {a}–{b} ms")
        if result and result[-1]["phase"] == phase:
            result[-1]["end"] = b
        else:
            result.append({"phase": phase, "start": a, "end": b})
    return result


def accounting_totals(timeline):
    totals = dict.fromkeys(PHASE_LABELS, 0.0)
    for segment in accounting_segments(timeline):
        phase = segment["phase"]
        totals[phase] = totals.get(phase, 0) + segment["end"] - segment["start"]
    return totals


def phase_label(phase):
    if phase.startswith("code:"):
        return phase[5:]
    return {"callback": "Callback execution / continuation",
            "dispatch": "Event-loop wait / callback dispatch"}.get(phase, PHASE_LABELS.get(phase, phase))


CODE_GROUPS = {
    "Facade / client construction": "Client & topology initialization",
    "Native client construction": "Client & topology initialization",
    "Native URI/options parsing": "Client & topology initialization",
    "Direct URI rewrite": "Client & topology initialization",
    "Read plugin topology": "Client & topology initialization",
    "Topology construction": "Client & topology initialization",
    "Load runtime adapter": "Runtime & handshake metadata",
    "Container metadata probe": "Runtime & handshake metadata",
    "Load no-monitoring module": "No-monitoring initialization",
    "Activate no-monitoring patch": "No-monitoring initialization",
}

CODE_COLORS = {
    "Client & topology initialization": "#047857",
    "Runtime & handshake metadata": "#a16207",
    "No-monitoring initialization": "#9333ea",
    "Read TLS CA certificate": "#be123c",
    "Await handshake metadata": "#a16207",
    "TLS socket/context construction": "#f97316",
}


def display_segments(segments):
    result = []
    for segment in segments:
        phase = segment["phase"]
        if phase.startswith("code:"):
            phase = "code:" + CODE_GROUPS.get(phase[5:], phase[5:])
        if result and result[-1]["phase"] == phase and result[-1]["end"] == segment["start"]:
            result[-1]["end"] = segment["end"]
        else:
            result.append({**segment, "phase": phase})
    return result


def phase_color(phase):
    if phase == "monitor":
        return "#ddd6fe"
    if phase == "callback":
        return "#0891b2"
    if phase == "dispatch":
        return "#f472b6"
    return CODE_COLORS[CODE_GROUPS.get(phase[5:], phase[5:])]


def local_samples(data):
    rows = []
    for sample in data["samples"]:
        if sample["variant"] not in ("native", "serverless-no-monitoring"):
            continue
        trace = sample["trace"]
        start = trace["start"]
        command = trace["command"]
        dns = [{"kind": q["kind"], "start": q["start"] - start, "end": q["end"] - start}
               for q in trace.get("dns", [])]
        dns_durations = {kind: sum(q["end"] - q["start"] for q in dns if q["kind"] == kind)
                         for kind in ("SRV", "TXT")}
        dns_durations["seedlistWall"] = max(q["end"] for q in dns) - min(q["start"] for q in dns) if dns else 0
        lookup = command["socket"].get("lookup")
        dns_durations["selectedHostname"] = lookup[1] - lookup[0] if lookup else 0
        connections = []
        for socket in trace["sockets"]:
            phases = {
                phase: [value - start for value in socket[phase]]
                for phase in ("lookup", "tcp", "tls", "hello", "auth")
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
        gaps = event_gap_segments(sample)
        lifecycle = trace.get("lifecycle", {})
        lifecycle_durations = {
            name: sum(end - begin for begin, end in interval) if name == "checkouts" else interval[1] - interval[0]
            for name, interval in lifecycle.items()
        }
        gap_durations = {
            phase: sum(gap["end"] - gap["start"] for gap in gaps if gap["phase"] == phase)
            for phase in GAP_COLORS
        }
        gap_durations["unclassified"] = sample["timings"]["other"] - sum(gap_durations.values())
        if gap_durations["unclassified"] < -1e-6:
            raise ValueError("Lifecycle windows double-count measured phases")
        extra = {}
        if trace.get("execution"):
            extra["execution"] = [{**e, "source": data["executionSources"][e["sourceId"]] if "sourceId" in e else e.get("source"), "start": e["start"] - start, "end": e["end"] - start}
                                  for e in trace["execution"]["segments"]]
            extra["activities"] = [{**a, "start": a["start"] - start, "end": a["end"] - start}
                                   for a in trace["activities"]]
            extra["threadCpuMs"] = trace["execution"]["threadCpuMs"]
            counters = trace.get("cgroupCpu")
            if counters:
                before = dict(line.split() for line in counters["before"].splitlines())
                after = dict(line.split() for line in counters["after"].splitlines())
                extra["throttledMs"] = (int(after["throttled_usec"]) - int(before["throttled_usec"])) / 1000
        rows.append(
            {
                "mode": "native-cluster"
                if sample["variant"] == "native"
                else "serverless",
                "operation": sample["operation"],
                "batch": sample.get("batch", 1),
                "block": [sample.get("batch", 1), sample.get("iteration", 0)],
                "servedRole": sample["servedRole"],
                "applicationConnectionReadyMs": sample["applicationConnectionReadyMs"],
                "lifecycleDurations": lifecycle_durations,
                "dnsDurations": dns_durations,
                "gapDurations": gap_durations,
                "timeline": {
                    **extra,
                    "total": sample["timings"]["total"],
                    "gaps": gaps,
                    "dns": dns,
                    "connections": connections,
                    "command": {
                        "send": [command["start"] - start, command["sent"] - start],
                        "receive": [command["sent"] - start, command["end"] - start],
                    },
                },
            }
        )
    return rows


def comparison_stats(rows):
    blocks = {}
    for row in rows:
        key = tuple(row.get("block", (row.get("batch", 1), row.get("round", 0))))
        blocks.setdefault(key, {mode: [] for mode in MODES})[row["mode"]].append(row["timeline"]["total"])
    if any(not values[mode] for values in blocks.values() for mode in MODES):
        raise ValueError("Each bootstrap block must contain paired driver measurements")
    totals = [{mode: (sum(values[mode]), len(values[mode])) for mode in MODES} for values in blocks.values()]

    def reduction(selected):
        means = {mode: sum(block[mode][0] for block in selected) / sum(block[mode][1] for block in selected) for mode in MODES}
        return 100 * (1 - means["serverless"] / means["native-cluster"])

    grouped = {}
    for key, value in zip(blocks, totals):
        grouped.setdefault(key[0], []).append(value)
    rng = random.Random(0)
    estimates = []
    for _ in range(2000):
        selected_batches = rng.choices(list(grouped.values()), k=len(grouped))
        selected = [block for batch in selected_batches for block in rng.choices(batch, k=len(batch))]
        estimates.append(reduction(selected))
    estimates.sort()
    batches = [{"batch": batch, "reductionPercent": reduction(values)} for batch, values in sorted(grouped.items())]
    return {"reductionPercent": reduction(totals), "confidence95Percent": [estimates[49], estimates[1949]],
            "blocks": len(blocks), "bootstrapResamples": 2000,
            "bootstrapMethod": "resample batches, then paired iterations/rounds within each batch", "batches": batches}


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
                    "standardDeviation": stdev(totals) if len(totals) > 1 else None,
                    "coefficientOfVariationPercent": 100 * stdev(totals) / mean(totals) if len(totals) > 1 else None,
                    "medianAbsoluteDeviation": median(abs(value - median(totals)) for value in totals),
                    "p95": totals[math.ceil(0.95 * len(totals)) - 1],
                    "roles": dict(Counter(row["servedRole"] for row in group)),
                    "sockets": dict(
                        Counter(len(row["timeline"]["connections"]) for row in group)
                    ),
                }
            )
            if group[0].get("dnsDurations"):
                result[-1]["dnsMeanMs"] = {
                    name: mean(row["dnsDurations"][name] for row in group)
                    for name in group[0]["dnsDurations"]
                }
            if group[0].get("lifecycleDurations"):
                result[-1]["lifecycleMeanMs"] = {
                    name: mean(row["lifecycleDurations"][name] for row in group)
                    for name in group[0]["lifecycleDurations"]
                }
                result[-1]["gapMeanMs"] = {
                    name: mean(row["gapDurations"][name] for row in group)
                    for name in group[0]["gapDurations"]
                }
    return result


def draw_gaps(axis, timeline, y):
    if "execution" in timeline:
        for segment in display_segments(accounting_segments(timeline)):
            phase = segment["phase"]
            if phase in COLORS:
                continue
            axis.barh(y, segment["end"] - segment["start"], left=segment["start"],
                      height=0.36, color=phase_color(phase), zorder=2.6)
        return
    for gap in timeline.get("gaps", []):
        axis.barh(y, gap["end"] - gap["start"], left=gap["start"], height=0.36,
                  color=GAP_COLORS[gap["phase"]][0], zorder=4)


def draw_connection(axis, connection, y, timeline=None):
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
    if timeline and "execution" in timeline:
        spans = [(e["kind"], e["start"], e["end"]) for e in timeline["execution"]]
        spans += [("code:" + a["name"], a["start"], a["end"]) for a in
                  sorted(timeline.get("activities", []), key=lambda a: (a["kind"] == "sync", -(a["end"] - a["start"])))]
        for phase, begin, end in spans:
            begin, end = max(begin, connection["start"]), min(end, connection["end"])
            if end > begin:
                axis.barh(y, end - begin, left=begin, height=0.36,
                          color=phase_color(phase), zorder=2.5)
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
        f"~{timeline['total']:.1f} ms",
        va="center",
        fontsize=10,
        weight="bold",
    )


def draw_off_cpu(axis, timeline, y):
    for span in timeline.get("execution", []):
        off_cpu = span["end"] - span["start"] - span["threadCpuMs"]
        if span["kind"] != "callback" or off_cpu < 2:
            continue
        axis.barh(y, span["end"] - span["start"], left=span["start"], height=0.4,
                  color="none", edgecolor="#334155", hatch="///", linewidth=0.5, zorder=6)
        source = span["source"]
        label = ("SCRAM continuation" if "/auth/scram" in source else
                 "Handshake continuation" if "performInitialHandshake" in source else
                 "Pool-ready continuation" if "ConnectionPool.createConnection" in source else
                 "Callback")
        axis.text((span["start"] + span["end"]) / 2, y,
                  f"{label}\n~{off_cpu:.1f} ms off CPU", fontsize=7.5, ha="center", va="center",
                  bbox={"facecolor": "white", "alpha": 0.88, "edgecolor": "none", "pad": 1}, zorder=7)


def section_spans(row):
    timeline = row["timeline"]
    connections = timeline["connections"]
    selected = next(c for c in reversed(connections) if c["kind"] == "application" and c["selected"])
    ready = row.get("applicationConnectionReadyMs", selected["end"])
    result = [{"label": "Setup", "start": 0, "end": min(c["start"] for c in connections)}]
    for connection in connections:
        result.append({"label": "Application Connection" if connection["kind"] == "application" else "Monitor Connection",
                       "start": connection["start"], "end": ready if connection is selected else connection["end"],
                       "connection": connection})
    result.append({"label": "Operation", "start": ready, "end": timeline["total"]})
    return result


def chart_heading(operation, native, serverless):
    reduction = 100 * (1 - serverless["median"] / native["median"])

    def pair(field, approximate=True):
        return "→".join(("~" if approximate else "") + f"{stats[field]:.1f}"
                        if stats[field] is not None else "n/a" for stats in (native, serverless))

    return (f"{operation.title()} · median {pair('median')} ms ({reduction:.1f}% less) · "
            f"mean {pair('mean')} · SD {pair('standardDeviation')} · CV {pair('coefficientOfVariationPercent', False)}%")


def callback_work(stack):
    if any("/benchmark/dist/execution.js" in frame["url"] and frame["function"] in
           {"init", "before", "after", "transition", "start", "stop"} for frame in stack):
        return "tracing overhead"
    names = {frame["function"] for frame in stack}
    if "parseSslOptions" in names and names.intersection({"isIP", "isIPv4", "isIPv6"}):
        return "IP validation"
    if any("/cmap/auth/scram.js" in frame["url"] for frame in stack):
        return "SCRAM preparation"
    labels = {"Server": "server creation", "ConnectionPool": "pool creation",
              "Monitor": "monitor creation", "Connection": "connection creation",
              "performInitialHandshake": "handshake setup", "executeHandshake": "handshake setup",
              "serverUpdateHandler": "topology updates", "command": "command handling",
              "executeOperationWithRetries": "operation execution", "executeOperation": "operation execution",
              "checkIn": "pool check-in", "Db": "database handle", "db": "database handle"}
    for frame in stack:
        if "/mongodb/lib/" in frame["url"] and frame["function"] in labels:
            return labels[frame["function"]]
    return "other work"


def callback_legend(data, group):
    counts = {}
    for entry in data.get("callbackProfile", {}).get("stacks", []):
        if entry["group"] == group:
            name = callback_work(entry["stack"])
            counts[name] = counts.get(name, 0) + entry["samples"]
    names = sorted((name for name in counts if name != "other work"), key=lambda name: -counts[name])[:3]
    return "Callbacks (" + ", ".join(names or ["not sampled"]) + ")"


def legend_order(rows, group):
    first_seen = {}
    for row in rows:
        timeline = row["timeline"]
        sections = section_spans(row)
        first_socket = sections[0]["end"]
        ready = sections[-1]["start"]
        begin, end = {"Setup": (0, first_socket), "Connection": (first_socket, ready),
                      "Operation": (ready, timeline["total"])}[group]
        spans = display_segments(accounting_segments(timeline))
        spans += [{"phase": phase, "start": a, "end": b} for c in timeline["connections"]
                  for phase, (a, b) in c["phases"].items()]
        for span in spans:
            if span["start"] < end and span["end"] > begin:
                phase = span["phase"]
                first_seen[phase] = min(first_seen.get(phase, float("inf")), max(span["start"], begin) - begin)
    return sorted(first_seen, key=lambda phase: (first_seen[phase], phase))


def draw_sections(axis, row, lanes, selected_y, direct=False):
    for section in section_spans(row):
        begin, end = section["start"], section["end"]
        connection = section.get("connection")
        y = lanes[connection["host"]] if connection else selected_y
        if section["label"] == "Setup":
            y = 3.2
        if direct:
            y = -0.55
        offset = 0.31 if connection else 0.66
        label = section["label"]
        text = f"{label} (~{end - begin:.1f} ms)"
        if connection:
            text = text.replace(" Connection (", " Connection\n(")
        axis.plot([begin, begin, end, end], [y + offset - 0.03, y + offset, y + offset, y + offset - 0.03],
                  color="#64748b", linewidth=0.7, zorder=8)
        axis.text((begin + end) / 2, y + offset + 0.03, text, ha="center", va="bottom",
                  fontsize=7.5, color="#334155", zorder=8)


def cpu_annotation(timeline):
    label = f"Main-thread CPU ~{timeline['threadCpuMs']:.1f} ms"
    throttled = timeline.get("throttledMs", 0)
    if round(throttled, 1) > 0:
        label += f" · cgroup throttled ~{throttled:.1f} ms"
    return label


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
        draw_connection(axis, connection, y, timeline)
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
    draw_gaps(axis, timeline, lanes[selected["host"]])
    draw_command(axis, timeline, lanes[selected["host"]])
    draw_off_cpu(axis, timeline, lanes[selected["host"]])
    first = min(connection["start"] for connection in connections)
    if "execution" in timeline:
        for segment in display_segments(accounting_segments(timeline)):
            end = min(first, segment["end"])
            if segment["start"] < end:
                phase = segment["phase"]
                color = COLORS[phase] if phase in COLORS else phase_color(phase)
                axis.barh(2.2, end - segment["start"], left=segment["start"], height=2.4, color=color, alpha=0.55, zorder=0)
    else:
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
        draw_connection(axis, connection, -0.55, direct)
    draw_gaps(axis, direct, -0.55)
    draw_command(axis, direct, -0.55)
    draw_off_cpu(axis, direct, -0.55)
    draw_sections(axis, native, lanes, lanes[selected["host"]])
    draw_sections(axis, serverless, lanes, -0.55, direct=True)
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
    dns = timeline.get("dns", [])
    if dns:
        begin = min(query["start"] for query in dns)
        end = max(query["end"] for query in dns)
        segment = axis.barh(2.2, end - begin, left=begin,
                            height=2.4, color=COLORS["clusterDns"], zorder=4)[0]
        segment.set_gid("cluster-dns")
    if "execution" in timeline:
        for item, y in [(timeline, 0.60), (direct, -1.02)]:
            scopes = [a for a in item.get("activities", []) if a["kind"] == "sync" and "threadCpuMs" in a]
            delayed = max(scopes, key=lambda a: a["end"] - a["start"] - a["threadCpuMs"], default=None)
            if delayed and delayed["end"] - delayed["start"] - delayed["threadCpuMs"] > 2:
                axis.text(0, y, f"{delayed['name']}: ~{delayed['end'] - delayed['start']:.1f} ms elapsed; ~{delayed['threadCpuMs']:.1f} ms thread CPU",
                          fontsize=8, color="#475569")
            else:
                axis.text(0, y, cpu_annotation(item), fontsize=8, color="#475569")
    axis.set_ylim(-1.2, 4)


def run_caption(data, environment):
    groups = Counter((sample.get("variant", sample.get("mode")), sample["operation"])
                     for sample in data["samples"])
    counts = sorted(set(groups.values()))
    iterations = str(counts[0]) if len(counts) == 1 else f"{counts[0]}–{counts[-1]}"
    count = f"{iterations} iterations per driver/operation · {len(data['samples'])} total cold invocations"
    if "runDurationSeconds" in data:
        seconds = round(data["runDurationSeconds"])
        count += f" · elapsed ~{seconds // 60}m {seconds % 60:02d}s"
    if "batches" in data:
        count += f" · {len(data['batches'])} batches"
    if environment == "aws":
        region = data.get("region", "region not recorded")
        location = "Sydney (ap-southeast-2)" if region == "ap-southeast-2" else region
        hardware = f"AWS Lambda · {location} · {data.get('architecture', 'architecture not recorded').upper()} · {data['memoryMB']} MB memory"
    else:
        metadata = data["environment"]
        host = metadata.get("host", {})
        cpu = host.get("cpu", "host CPU not recorded")
        memory = f" · {host['memoryBytes'] / 1024**3:g} GiB host RAM" if "memoryBytes" in host else ""
        docker = json.loads(metadata["docker"])
        quota = "no CPU quota" if metadata["cpuMax"].startswith("max ") else "CPU quota " + metadata["cpuMax"]
        hardware = f"Local host · {cpu}{memory} · Docker {docker['Arch'].upper()} · {int(metadata['memoryMax']) / 1024**3:g} GiB client RAM · {quota}"
        if data["configuration"].get("noMonitoringComparison"):
            count = count.replace("total cold invocations", "total cold invocations (including control)")
    return count + "\n" + hardware


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
    diagnostic = any("execution" in row["timeline"] for row in rows)
    figure, axes = plt.subplots(1, 2, figsize=(22, 11 if diagnostic else 9))
    figure.subplots_adjust(left=0.12, right=0.97, top=0.72, bottom=0.34, wspace=0.42)
    label = "Local Docker" if environment == "local" else "AWS Lambda"
    date = data.get("createdAt", data.get("recordedAt", ""))[:10]
    figure.suptitle(
        f"{label} · replica-set discovery and direct connections",
        fontsize=20,
        weight="bold",
        y=0.97,
    )
    sample_caption = "Individual traces nearest cohort medians"
    figure.text(
        0.5,
        0.93,
        run_caption(data, environment) + "\n" + f"Measured {date}. {sample_caption}. " + ("Diagnostic probes enabled; timings include tracing overhead." if diagnostic else "Headings compare cohort medians."),
        va="top",
        ha="center",
        fontsize=11,
    )
    if environment == "aws":
        figure.text(
            0.5,
            0.83,
            "Point-in-time snapshot; not a statement of current performance.",
            ha="center",
            fontsize=11,
        )
    for axis, operation in zip(axes, ("read", "write")):
        native = representatives[operation, "native-cluster"]
        serverless = representatives[operation, "serverless"]
        draw_node_lanes(axis, native, serverless, member_letters)
        for item in summary:
            if item["operation"] == operation:
                row = native if item["driver"] == "native-cluster" else serverless
                item["illustratedTraceAccountingMs"] = accounting_totals(row["timeline"])
                item["illustratedTraceSegments"] = accounting_segments(row["timeline"])
        comparison = comparison_stats([row for row in rows if row["operation"] == operation])
        for item in summary:
            if item["operation"] == operation:
                item["comparison"] = comparison
        distributions = {item["driver"]: item for item in summary if item["operation"] == operation}
        axis.set_title(chart_heading(operation, distributions["native-cluster"], distributions["serverless"]),
                       loc="left", fontsize=9.5, weight="bold", pad=15)
        axis.set_xlim(
            0, max(native["timeline"]["total"], serverless["timeline"]["total"]) * 1.15
        )
        axis.set_xlabel("Milliseconds since handler invocation")
        axis.grid(axis="x", alpha=0.15)
        axis.set_axisbelow(True)
        axis.spines[["top", "right", "left"]].set_visible(False)
    show_gaps = not diagnostic and any(row["timeline"].get("gaps") for row in rows)
    visible_code = {segment["phase"][5:] for row in representatives.values()
                    for segment in display_segments(accounting_segments(row["timeline"])) if segment["phase"].startswith("code:")}
    groups = {"Setup": [], "Connection": [], "Operation": []}
    phase_names = {"clusterDns": "Cluster DNS", "lookup": "Host DNS", "tcp": "TCP", "tls": "TLS",
                   "hello": "Hello", "auth": "Auth", "send": "Command → write", "receive": "Write → reply"}
    for phase, color in COLORS.items():
        group = "Setup" if phase == "clusterDns" else "Operation" if phase in ("send", "receive") else "Connection"
        groups[group].append(Patch(facecolor=color, label=phase_names[phase], gid=phase))
    if diagnostic:
        for name, color in CODE_COLORS.items():
            if name in visible_code:
                group = "Connection" if name in ("TLS socket/context construction", "Await handshake metadata") else "Setup"
                groups[group].append(Patch(facecolor=color, label=name, gid="code:" + name))
        groups["Connection"].append(Patch(facecolor=phase_color("monitor"), label="Replica-set monitor activity", gid="monitor"))
        for title, group in groups.items():
            group.extend([Patch(facecolor=phase_color("callback"), label=textwrap.fill(callback_legend(data, title), width=48), gid="callback"),
                          Patch(facecolor=phase_color("dispatch"), label="Event-loop wait / dispatch", gid="dispatch")])
    else:
        if show_gaps:
            for phase, (color, name) in GAP_COLORS.items():
                groups["Connection" if phase == "poolGaps" else "Operation"].append(Patch(facecolor=color, label=name, gid=phase))
        groups["Setup"].append(Patch(facecolor="#94a3b8", label="Before first socket: cause unmeasured", gid="beforeSocket"))
        groups["Operation"].append(Patch(facecolor="#e2e8f0", label="Between events: cause unmeasured", gid="unattributed"))
    for (title, handles), x, columns in zip(groups.items(), (0.20, 0.45, 0.70), (1, 1, 1)):
        order = legend_order(representatives.values(), title)
        handles.sort(key=lambda handle: order.index(handle.get_gid()) if handle.get_gid() in order else len(order))
        legend = figure.legend(handles=handles, title=title, loc="upper left", bbox_to_anchor=(x, 0.28),
                               ncol=columns, fontsize=8.5, title_fontsize=11, frameon=False,
                               columnspacing=1, handlelength=1.6)
        legend.get_title().set_fontweight("bold")
    figure.text(
        0.5,
        0.025,
        "Mean and SD are in ms; CV = SD / mean. Arrows compare MongoDB → serverless. Concurrent node lanes must not be added.\n"
        + (f"Callback names: largest named sampled work per stage in a separate {data['callbackProfile']['invocations']}-invocation local profile; not a complete attribution of these bars.\n" if data.get("callbackProfile") else "")
        + ("Hatching spans callbacks with measured off-CPU time; it does not locate individual pauses. Cgroup counters cover all threads. ~ marks rounded timings." if diagnostic else
           "~ marks rounded timings; grey spans retain elapsed time whose cause is not profiled. Imports, watcher work, client close and Lambda INIT are outside the measurement."),
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
    data = json.loads(arguments.samples.read_text())
    output = arguments.output_dir or arguments.samples.parent
    render(data, arguments.environment, output)
