# Benchmark results

Keep exactly two checked-in result folders: `results/local/` and `results/aws/`.
Each contains the latest complete measurement for that environment:
`samples.json`, `summary.json`, `results.md`, `read-latency.png`, and
`write-latency.png`. Refresh those files together. A local run must not replace
AWS results.

Checked-in results state the last measured performance. Include the measurement
date, runtime, workload, sample counts, instrumentation, and timing boundaries.
Do not include earlier revisions, historical controls, or before/after claims.
Keep comparisons with main or earlier runs in temporary files and PR notes.
Git history retains replaced measurements; do not add archive result folders.

Preserve the detailed connection timeline unless Luke explicitly requests a
different format. Show all sockets and every measured interval: SSM retrieval,
DNS, TCP, TLS, hello, authentication, discovery, role validation, the operation,
measured code scopes, and callback/dispatch time. Use the same phase colours and
legends for local and AWS reports. Do not replace this with total-only bars.

The JSON, statistics, and chart must come from the same run. Show actual traces
nearest their cohort medians, with separate one- and two-connection write groups.
Account for the full measured interval without adding overlapping socket phases.
Label timing outside the interval, including Lambda INIT and client close.
Never invent detail absent from the recorded probes; collect new data instead.

Use synthetic traces for report unit tests. Do not retain old performance
snapshots as test fixtures. Validate LocalStack before AWS, run the report tests,
and inspect both rendered charts before publishing.
