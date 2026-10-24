# Cold connection benchmark

Measures the first MongoDB read or write after a cold start for four patterns:
native MongoDB, the serverless driver without a plugin, and the serverless driver
with the SSM plugin with and without cached topology. The checked-in
[local results](results/local/results.md) and [AWS results](results/aws/results.md)
are the latest complete run for each environment.

Both environments run the same handler (`lambda-worker.ts`). The URI, and for the
SSM patterns the cached topology, are fetched from SSM at startup, before the
measurement starts. The measurement runs from handler entry to the operation result.

## Run locally

Requires Docker, Node 24, pnpm and Python 3. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm benchmark --samples 40
python3 -m venv /tmp/mongodb-benchmark-report
/tmp/mongodb-benchmark-report/bin/pip install -r benchmark/requirements-report.txt
/tmp/mongodb-benchmark-report/bin/python benchmark/report.py benchmark/results/local/samples.json
```

`pnpm benchmark` starts a three-member TLS replica set, DNS with SRV and TXT
records, and LocalStack for SSM, all in Docker. Each sample is a fresh Node process
in the client container. netem adds a 1.3 ms round trip between every pair of
containers (`--rtt`), matching the TCP connect times measured on AWS. CI runs the
same command with 40 samples per pattern and requires the cached SSM plugin to be
at least 10% faster than native for both reads and writes.

## Run on AWS

Needs an AWS profile allowed to manage the benchmark resources, and an existing
function whose `MONGODB_URI` is an SRV connection string. The script copies the
URI into a SecureString parameter without logging it.

```sh
pnpm benchmark:build
node benchmark/build-lambda.mjs /tmp/mongodb-pattern-runtime/worker
AWS_PROFILE=personal node benchmark/lambda-aws.mjs --samples 200 \
  --source-function mongodb-serverless-prod-worker-1 --region ap-southeast-2
/tmp/mongodb-benchmark-report/bin/python benchmark/report.py benchmark/results/aws/samples.json
```

It creates eight `mongodb-serverless-pattern-*` functions (Node 24, arm64, 1769 MB,
no VPC), an IAM stack, and parameters under `/mongodb-serverless-pattern/`. Each
round publishes a fresh version of every function and invokes it once, so every
sample is a cold start. Measured versions are deleted after each round; the
functions stay for later runs. To remove everything, delete the eight functions,
their log groups, the parameters and the `mongodb-serverless-pattern-permissions`
stack.

AWS needs 200 samples per pattern for stable medians because conditions vary
between cold starts. Local runs vary much less, so 40 is enough there.

## Reading the charts

Each case has its own chart, showing the sample nearest the cohort median. Rows
are the replica-set members the sample contacted, in the order it contacted them.

Every timed phase comes from events: driver events (`serverHeartbeat*`,
`connectionCreated`, `connectionReady`, checkout and command events) and socket
events (`lookup`, `connect`, `secureConnect` and the first reply), observed
through the `net.client.socket` diagnostics channel. Nothing in the driver is
patched, and no stacks are captured.

Setup runs from handler entry to the first member socket. It has no events
inside it, so the chart splits it in proportions from an earlier run with code
probes, marked `~`. Gaps between events are named by the event before them:
command preparation after a connection is ready, topology parsing and member
selection after discovery, and returning the result after the reply. "Waiting on
another member" marks time when the operation's member is idle while another
member's row is busy.

## Limitations

Local medians are lower than on AWS. A cold Lambda TLS handshake takes about
40 ms against about 4 ms locally, so native MongoDB's monitor handshakes cost
proportionally less locally and the serverless reductions are smaller.

DNS queries cannot be observed through events, so the SRV and TXT time inside
setup is an estimate. The benchmark reads with `nearest` and writes to the
primary with majority acknowledgement. It does not measure tags, staleness,
latency windows or elections; see [operation preferences](../docs/operation-preferences.md).

Each uncached SSM sample uses a fresh topology parameter, deleted outside the
measurement, because SSM blocks recreating a deleted name for 30 seconds.

CI jobs that start MongoDB 8 run on Ubuntu 22.04, because newer hosted kernels
are incompatible ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)).
