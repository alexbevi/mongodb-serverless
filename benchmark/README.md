# Cold connection benchmark

Measure the first MongoDB read or write in a cold Lambda execution environment.
The checked-in [local results](results/local/results.md) and
[AWS results](results/aws/results.md) contain the latest complete run for each
environment. Each report includes raw samples, summary statistics, and a detailed
connection timeline.

## Install and run

Requires Docker, Node 24, pnpm, Python, and zip. LocalStack is pinned to 4.14.0.
Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm benchmark:build
python3 -m venv /tmp/mongodb-benchmark-report
/tmp/mongodb-benchmark-report/bin/pip install -r benchmark/requirements-report.txt
node benchmark/build-lambda.mjs /tmp/mongodb-pattern-runtime/worker
node benchmark/lambda-local.mjs --samples 40
/tmp/mongodb-benchmark-report/bin/python benchmark/compact.py --diagnostics benchmark/results/local/samples.json
/tmp/mongodb-benchmark-report/bin/python benchmark/lambda-report.py benchmark/results/local/samples.json
```

[Lambda benchmark usage](LAMBDA.md) covers AWS deployment, SSM permissions,
resource cleanup, and measurement verification. Refresh the raw samples, summary,
report, and image together for the environment being measured.

## Read the timeline

Each panel shows a measured trace nearest its cohort median. Headings give the
cohort median, p95, mean, standard deviation (SD), coefficient of variation
(CV), and count; the number at the end of the trace is that sample's
actual duration. No-plugin writes have separate panels for a primary landing
(one connection) and a secondary landing (two connections).

The timer starts before SSM retrieval and ends at the operation result. Every
measured interval is accounted for. Colours identify SSM, cluster and host DNS,
TCP, TLS, hello, authentication, topology discovery, role validation, command
preparation, socket write, reply, and measured code scopes. Callback and dispatch
segments retain elapsed time without inferring its cause.

Each socket has its own lane. Concurrent lanes overlap and must not be added.
The summary records a non-overlapping accounting of each illustrated trace:
SSM and discovery/validation requests, the operation, application socket phases,
cluster DNS, monitor activity, code scopes, and callback/dispatch intervals, in
that priority order. A higher-priority interval owns overlapping elapsed time.
This wall-clock accounting is not a CPU profile.

Hatching marks callbacks whose elapsed time exceeds their measured thread CPU
by at least 2 ms. It covers the callback interval, without locating individual
scheduling pauses or establishing their cause. Repeated execution stacks are
stored once in `executionSources`; each segment retains its source identifier
and measured times. [Trace encoding](TRACE_FORMAT.md) describes the lossless
column format and how to expand it for inspection.

## Diagnostic harness and CI

A separate Docker harness exercises native discovery and direct routing with
controlled network delays. CI runs its 100-iteration performance gate without
profiling, followed by a separate diagnostic run. Its output is disposable and
does not replace the checked-in Lambda results.

```sh
pnpm benchmark --diagnostics --no-monitoring --samples 100 --output /tmp/mongodb-diagnostic/samples.json
/tmp/mongodb-benchmark-report/bin/python benchmark/report.py /tmp/mongodb-diagnostic/samples.json --environment local
/tmp/mongodb-benchmark-report/bin/python -m unittest discover -s benchmark/test -p '*report_test.py'
/tmp/mongodb-benchmark-report/bin/python -m unittest discover -s benchmark/test -p results_test.py
```

The LocalStack CI job also verifies fresh Lambda environments, serving roles,
connection counts, DNS activity, SSM request counts, and complete timeline
accounting. It publishes JSON and images as workflow artifacts.

## Limitations

Detailed probes add overhead. Lambda INIT, module loading, client close,
provisioning, and invocation transport are outside the main timer. INIT and
reported handler durations are retained separately when available.

LocalStack tests API behavior and Lambda execution locally. Its CPU allocation,
network, and KMS emulation do not predict AWS performance. AWS measurements apply
to the recorded region, cluster, runtime, and workload. Reads explicitly use
`nearest`; writes require a primary and majority acknowledgement. This benchmark
does not establish parity for tags, staleness, latency windows, preferred-mode
fallback, or concurrent elections. See [operation preferences](../docs/operation-preferences.md).
