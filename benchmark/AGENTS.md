# Benchmark results

Keep exactly two checked-in result folders: `results/local/` and `results/aws/`.
Each contains the latest complete measurement for that environment:
`samples.json.gz`, `summary.json`, `results.md`, and one chart per case. Refresh
them together with `report.py`. A local run must not replace AWS results.

Checked-in results state the last measured performance: date, runtime, workload,
sample counts and timing boundaries. Do not include earlier revisions or
before/after claims. Keep comparisons with main or earlier runs in PR notes.
Git history retains replaced measurements; do not add archive folders.

Time phases from events only: driver events and socket events through the
`net.client.socket` diagnostics channel. Do not patch the driver or Node, and do
not capture stacks or profile callbacks. Name a gap by the event before it when
that identifies the work; reserve "Other handler work" for gaps nothing explains.
Mark estimates with `~`.

Charts show one row per contacted member, in contact order, with Setup spanning
those rows and the operation's row carrying checkout waits and remaining work.
Use the same phase colours for local and AWS.

Run 40 samples per pattern locally and in CI, and 200 on AWS. Use synthetic
traces for report tests. Run the report tests and look at the charts before
publishing.
