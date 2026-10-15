# Local connection benchmark

MongoDB driver discovery compared with direct connections through the serverless
driver, measured against a local three-member TLS replica set.

![Local connection timings](benchmark/results/local/latency.png)

The diagram shows the latest retained local run. Each trace is the sample nearest
its driver/operation median; headings report means across all samples. Every socket
opened by each illustrated sample is shown, including additional application
connections when `connect()` and the operation select different members.

[Raw samples](benchmark/results/local/samples.json) ·
[Summary statistics](benchmark/results/local/summary.json) ·
[AWS results](benchmark/results/aws/results.md)

## Run locally

From the repository root, with Docker running:

```sh
npm run benchmark -- --no-monitoring --samples 48
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

Timing starts before client construction and ends when the operation returns.
Imports, process startup, watcher work and client close are excluded. Reads use
`secondaryPreferred`; writes use primary selection and majority acknowledgement.
The serverless driver receives watcher-provided direct member URIs. Watcher
selection happens outside the timed operation.

The MongoDB driver's monitors overlap. `connect()` and the operation select
independently, so a read can open two authenticated application connections.
`secondaryPreferred` may fall back to the primary when no secondary is known.

Docker CPU quotas and injected network delays do not reproduce Lambda scheduling,
DNS, processor speed or database load. These measurements describe the recorded
local run and do not predict AWS performance. See the
[harness usage and limitations](benchmark/README.md).
