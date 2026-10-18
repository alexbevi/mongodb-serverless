# Cold Lambda routing benchmark

Measure one read or write from each fresh Lambda execution environment. Compare
native MongoDB, the exact `origin/main` driver, this branch without a plugin, and
this branch with the SSM plugin. The main baseline uses the same SSM plugin as a
store adapter so both cached drivers pay for one decrypted parameter request.

## Run

Requires Docker, Node 24, pnpm, Python and zip. LocalStack is pinned to 4.14.0.

```sh
pnpm install --frozen-lockfile
pnpm benchmark:build
node benchmark/build-lambda.mjs /tmp/mongodb-pattern-runtime/worker origin/main
node benchmark/lambda-local.mjs --samples 40
python3 -m pip install -r benchmark/requirements-report.txt
python3 benchmark/lambda-report.py benchmark/results/lambda-localstack/samples.json
```

The local runner creates a TLS replica set, DNS SRV/TXT records, a SecureString,
and eight Lambda functions. It discovers and stores topology before collecting
cache hits. The preparation result is retained separately in the JSON. It removes
its Docker deployment on completion, including failures.

After local validation, deploy to AWS using a profile allowed to manage the
benchmark resources. The existing source function must have `MONGODB_URI` and
optionally `DATABASE` configured. Its URI must use SRV and explicit
`authSource=admin`; main cannot retain authentication settings from DNS TXT.
The script copies the URI directly to SecureString without logging it.

```sh
AWS_PROFILE=personal node benchmark/lambda-aws.mjs --samples 100 \
  --source-function mongodb-serverless-prod-worker-1 --region ap-southeast-2
python3 benchmark/lambda-report.py benchmark/results/lambda-aws/samples.json
```

This creates dedicated `mongodb-serverless-pattern-*` functions and an IAM
permissions stack, plus `/mongodb-serverless-pattern/uri` and `/topology` in SSM.
Lambda environment variables contain parameter paths, not credentials. Functions
use Node 24, arm64, 1769 MB, no VPC, a 30-second timeout, and scoped SSM/log access.
The script leaves the deployment for repeat runs and deletes measured function
versions after each round. To retire it, delete the eight functions, their log
groups, both parameters, and the `mongodb-serverless-pattern-permissions` stack.

## Measurements

Each round publishes a fresh version of every function. Each version receives
one invocation. The worker rejects reuse and the collector checks unique process
IDs. Variant order rotates and reverses across rounds; read/write order alternates.
All variants share the same package, MongoDB driver, TLS verification, SCRAM-SHA-1,
collection, and majority write concern. Retryable reads and writes are disabled.

Timing starts in the handler before the SSM read and stops at the operation
result. Lambda INIT and REPORT durations are saved separately. Client close,
function publication, deployment, and SDK module initialization are outside the
primary latency metric. Socket/DNS/command probes are enabled equally; callback
profiling and source probes are disabled. These are measured instrumented runs,
not an overhead-free estimate.

- Native and no-plugin invocations each fetch the URI through `GetParameter` with
  decryption, then perform SRV and TXT resolution. No topology crosses invocations.
- No-plugin reads explicitly permit either healthy member role with `nearest`.
  They reuse the discovery connection. Writes reuse a primary landing or open one
  additional connection after a secondary landing. Both landing groups are reported
  with their observed sample counts; random selection is not forced.
- Main and the SSM variant fetch URI and topology together with `GetParameters`.
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
