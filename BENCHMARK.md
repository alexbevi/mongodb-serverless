# Local connection benchmark

MongoDB driver discovery compared with direct connections through the serverless
driver, measured against a local three-member TLS replica set.

![Local connection timings](benchmark/results/local/latency.png)

The diagram shows the latest retained local run. Each trace is the sample nearest
its driver/operation median; headings report means across all samples. Every socket
opened by each illustrated sample is shown. The first operation connects
automatically, without an explicit `client.connect()` call.

Cluster DNS is one shared block spanning all three node lanes, covering the
overlapping SRV and TXT requests before any sockets open. Brown Host DNS segments show hostname
resolution for each socket;
blue TCP segments begin after resolution completes. The direct client skips the
SRV/TXT stage but still resolves its member hostname.

Magenta marks gaps within connection setup or pool checkout, teal marks the
remaining interval between connection readiness and command start, and pink marks
time after command success. These colours exclude the phases already shown and
do not overlap each other. They locate elapsed time between events without
identifying whether it was CPU work or scheduling delay.

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
