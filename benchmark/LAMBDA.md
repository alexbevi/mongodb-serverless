# Cold Lambda routing benchmark

Measure one read or write from each fresh Lambda execution environment using
native MongoDB, the serverless driver without a plugin, and the serverless driver
with cached topology in SSM. Reports describe the measured version. Comparisons
with earlier versions belong in PR notes, outside the checked-in results.

## Run

Requires Docker, Node 24, pnpm, Python and zip. LocalStack is pinned to 4.14.0.

```sh
pnpm install --frozen-lockfile
pnpm benchmark:build
node benchmark/build-lambda.mjs /tmp/mongodb-pattern-runtime/worker
node benchmark/lambda-local.mjs --samples 40
python3 -m pip install -r benchmark/requirements-report.txt
python3 benchmark/compact.py benchmark/results/local/samples.json
python3 benchmark/lambda-report.py benchmark/results/local/samples.json
```

The local runner creates a TLS replica set, DNS SRV/TXT records, a SecureString,
and six Lambda functions. It discovers and stores topology before collecting
cache hits. The preparation result is retained separately in the JSON. Before measuring cold
cohorts, each function receives a cold and warm call on `$LATEST`. The runner
checks environment and client reuse, with no further SSM, cluster DNS or
discovery. Serverless calls must reuse their direct sockets; native nearest reads
may open a connection in another member's pool. These six warm checks are recorded separately. It removes
its Docker deployment on completion, including failures.

After local validation, deploy to AWS using a profile allowed to manage the
benchmark resources. The existing source function must have `MONGODB_URI` and
optionally `DATABASE` configured. Its URI must use SRV.
The script copies the URI directly to SecureString without logging it.

```sh
AWS_PROFILE=personal node benchmark/lambda-aws.mjs --samples 100 \
  --source-function mongodb-serverless-prod-worker-1 --region ap-southeast-2
python3 benchmark/compact.py benchmark/results/aws/samples.json
python3 benchmark/lambda-report.py benchmark/results/aws/samples.json
```

This creates dedicated `mongodb-serverless-pattern-*` functions and an IAM
permissions stack, plus `/mongodb-serverless-pattern/uri` and `/topology` in SSM.
Lambda environment variables contain parameter paths, not credentials. Functions
use Node 24, arm64, 1769 MB, no VPC, a 30-second timeout, and scoped SSM/log access.
The script leaves the deployment for repeat runs and deletes measured function
versions after each round. To retire it, delete the six functions, their log
groups, both parameters, and the `mongodb-serverless-pattern-permissions` stack.

## Measurements

The default overview and average phase tables cover the handler through the
operation result. INIT, including the completed SSM fetch, stays in the raw JSON
and is excluded from that overview. Mean confidence intervals describe sampling
uncertainty within one run; they do not establish repeatability across deployments.

Each round publishes a fresh version of every function. Each version receives
one measured cold invocation. The collector rejects warm samples and checks unique execution
environment identifiers. Variant order rotates and reverses across rounds; read/write order alternates.
All variants share the same package, MongoDB driver, TLS verification, SCRAM-SHA-1,
collection, and majority write concern. Retryable reads and writes are disabled.

SSM retrieval completes during INIT, before handler entry. The handler creates
the MongoDB client lazily and retains it for warm calls. Handler timing stops at
the operation result. Lambda INIT and REPORT durations are saved separately;
INIT includes the SSM request. Publication, deployment and caller transport are
outside these measurements. The default package records socket, DNS and command
intervals without stack capture, callback CPU profiling or injected source probes.
Build with `node benchmark/build-lambda.mjs --diagnostics /path/to/worker` to
include those detailed probes. Both runners read the mode from the package and
verify it in every sample. All variants use the same instrumentation mode.
Without detailed probes, time outside protocol intervals is reported together
as other handler work and scheduling; its internal causes are not measured.
Instrumentation contributes to the recorded duration. AWS INIT comes from the
Lambda REPORT line. LocalStack omits that field, so its startup measurement uses
the Node performance clock through completed module initialization. The JSON
records the timing source; neither includes container provisioning.

- Native and no-plugin execution environments each fetch the URI through `GetParameter` with
  decryption, then perform SRV and TXT resolution. Warm invocations reuse the existing client.
- No-plugin reads explicitly permit either healthy member role with `nearest`.
  A suitable operation runs before discovery on the same connection. The call
  waits for discovery before returning, and its time remains in the handler total.
  Writes reuse a primary landing or open one additional connection after a
  secondary landing. Discovery uses handshake identity without another hello. Both landing groups are reported
  with their observed sample counts; random selection is not forced.
- During INIT, the SSM variant fetches URI and topology together with `GetParameters`.
  Cache hits open one authenticated direct connection, without SRV/TXT or discovery.
- Every sample checks the serving role, authenticated/monitor socket counts, DNS,
  discovery commands, SSM request count, and SDK attempts. A failure stops the run;
  the report refuses incomplete cohorts. Hostnames are replaced with stable labels.

## Limitations

LocalStack tests the API and Lambda path locally. Its latency, CPU allocation,
network and KMS emulation do not predict AWS performance. AWS measurements apply
to the recorded region, cluster, runtime and sample window. They include hostname
lookup but cannot force a cache miss in upstream DNS or AWS infrastructure.

This benchmark uses unrestricted reads and primary writes. It does not claim
native selection parity for tags, staleness, latency windows, preferred-mode
fallback, or concurrent elections. Those remain [future work](../docs/operation-preferences.md).
Normal healthy cache hits are measured separately from discovery and refresh.
Concurrent cache writes use last-write-wins. The cached URI lasts for a plugin
instance; create a new instance after credential rotation.
