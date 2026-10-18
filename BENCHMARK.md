# Connection benchmarks

The current benchmark measures two cold Lambda patterns: uncached discovery and
SSM topology reuse. Each timed invocation reads its URI from SecureString.

- [LocalStack 4.14 measurements](benchmark/results/lambda-localstack/results.md)
- [AWS Lambda measurements](benchmark/results/lambda-aws/results.md)
- [Reproduction steps and timing scope](benchmark/LAMBDA.md)

The new reports compare with the previously recorded main statistics below.
Those historical runs used detailed profiling and excluded SSM reads; their
percentages are descriptive, not a controlled estimate of the code change.
Fresh controls in the new reports use the same harness as the two new patterns.

## Previous main: local connection benchmark

MongoDB driver discovery compared with direct connections through the serverless
driver, measured against a local three-member TLS replica set.

![Local connection timings](benchmark/results/local/latency.png)

The diagram shows 100 cold invocations per driver/operation across four batches
of 25, with code probes,
callback tracing and socket/client events recording the full breakdown.
Each illustrated trace is the sample nearest its driver/operation median.
Headings report medians and the percentage reduction between those medians.
The first operation connects automatically, and the local client has no CPU quota.
The complete four-batch run took approximately 3m 38s, including compilation,
cluster setup and teardown. The command below collects one 100-iteration batch.

Timings include profiling overhead, so the percentages describe this instrumented
run. The [legend definitions](benchmark/README.md#reading-the-diagram) explain
the measured setup, connection and operation intervals. The summary retains
means, p95 and variability. MAD is the median absolute
distance from the median. The 95% interval for the mean reduction uses
2,000 bootstrap resamples, first sampling batches and then paired iterations
within each batch. The batch range shows the observed variation between runs;
four batches do not establish performance across all machines or workloads.

[Raw samples](benchmark/results/local/samples.json) ·
[Summary statistics](benchmark/results/local/summary.json) ·
[AWS results](benchmark/results/aws/results.md)

## Run locally

From the repository root, with Docker running:

```sh
npm run benchmark -- --diagnostics --no-monitoring --samples 100
python3 benchmark/compact.py benchmark/results/local/samples.json
python3 -m venv /tmp/mongodb-benchmark-report
/tmp/mongodb-benchmark-report/bin/pip install -r benchmark/requirements-report.txt
/tmp/mongodb-benchmark-report/bin/python benchmark/report.py benchmark/results/local/samples.json --environment local
```

The benchmark replaces `benchmark/results/local/samples.json`. The report command
replaces the local diagram and summary. It does not read or change the AWS snapshot.
Keep these diagnostic snapshots as the historical main baseline. The current
Lambda results live in `lambda-localstack/` and `lambda-aws/`; replace those
cohorts on a new measurement run. SVGs are ignored.

Repeated execution stacks are stored once in `executionSources`; each segment
retains a `sourceId` and its original timing measurements.

The raw local data includes the monitoring-enabled serverless control. The diagram
compares the MongoDB driver with the serverless driver with monitoring disabled.

## Measurement scope

Timing starts before handler invocation, including lazy client construction,
and ends when the handler returns.
Imports, process startup, watcher work and client close are excluded. Reads use
`secondary`; writes use primary selection and majority acknowledgement.
The serverless driver receives watcher-provided direct member URIs. Watcher
selection happens outside the timed operation.

The MongoDB driver's monitors overlap. Reads wait for an eligible secondary;
the benchmark rejects any read served by a primary. Connection readiness is measured from
public client events and matched to the socket that serves the operation;
`applicationConnectionReadyMs` includes discovery and authentication.

The local host and injected network delays do not reproduce Lambda scheduling,
DNS, processor speed or database load. These measurements describe the recorded
local run and do not predict AWS performance. See the
[harness usage and limitations](benchmark/README.md).
