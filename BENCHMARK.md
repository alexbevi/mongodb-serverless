# Local connection benchmark

MongoDB driver discovery compared with direct connections through the serverless
driver, measured against a local three-member TLS replica set.

![Local connection timings](benchmark/results/local/latency.png)

The diagram shows the latest local diagnostic run: four cold samples for each
read/write and driver variant, 24 invocations in total. Each illustrated trace is
the sample nearest its driver/operation median. All sockets are shown. The first
operation connects automatically, without an explicit `client.connect()` call.

The Setup, Connection and Operation legends follow the order in which phases
first appear. Related setup scopes share a colour; adjacent scopes in the same
group are merged. Cluster DNS spans all three MongoDB node lanes before the
connections split. Braces show selection of an application connection.

Every interval is covered by measured socket phases, code scopes or callback
execution/dispatch boundaries. Hatched callbacks contain more than 2 ms of
measured off-CPU time; the hatch does not locate individual pauses. Container
throttling counters provide supporting context but cover all threads.

These timings include diagnostic overhead and are not an uninstrumented savings
comparison. `~` marks rounded durations. The [legend definitions](benchmark/README.md#reading-the-diagram)
explain each interval and link to its instrumentation and implementation.

[Raw samples](benchmark/results/local/samples.json) ·
[Summary statistics](benchmark/results/local/summary.json) ·
[AWS results](benchmark/results/aws/results.md)

## Run locally

From the repository root, with Docker running:

```sh
npm run benchmark -- --diagnostics --no-monitoring --samples 4
python3 -m venv /tmp/mongodb-benchmark-report
/tmp/mongodb-benchmark-report/bin/pip install -r benchmark/requirements-report.txt
/tmp/mongodb-benchmark-report/bin/python benchmark/report.py benchmark/results/local/samples.json --environment local
```

The benchmark replaces `benchmark/results/local/samples.json`. The report command
replaces the local diagram and summary. It does not read or change the AWS snapshot.
Only one local result set and one AWS result set are retained; replace those
files instead of adding run folders. SVGs and other generated result files are ignored.

The raw local data includes the monitoring-enabled serverless control. The diagram
compares the MongoDB driver with the serverless driver with monitoring disabled.

## Measurement scope

Timing starts before handler invocation, including lazy client construction,
and ends when the handler returns.
Imports, process startup, watcher work and client close are excluded. Reads use
`secondaryPreferred`; writes use primary selection and majority acknowledgement.
The serverless driver receives watcher-provided direct member URIs. Watcher
selection happens outside the timed operation.

The MongoDB driver's monitors overlap. `secondaryPreferred` may fall back to
the primary when no secondary is known. Connection readiness is measured from
public client events and matched to the socket that serves the operation;
`applicationConnectionReadyMs` includes discovery and authentication.

Docker CPU quotas and injected network delays do not reproduce Lambda scheduling,
DNS, processor speed or database load. These measurements describe the recorded
local run and do not predict AWS performance. See the
[harness usage and limitations](benchmark/README.md).
