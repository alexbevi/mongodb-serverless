# Cold connection benchmark

Compare the stock MongoClient and the serverless wrapper against a three-member
Docker replica set with TLS, SCRAM-SHA-256 and network delay. Driver source files
are unchanged. This measures fresh database connections, not AWS Lambda startup.

## Install

Use Node 20.19 or later, Docker Compose, and the repository's installed development
dependencies. Docker must support `NET_ADMIN` and Linux `netem`. The client runs
inside Docker, so Docker Desktop's host forwarding is outside the measured path.

## Usage

```sh
npm run benchmark
npm run benchmark -- --samples 50 --local-rtt 0.5 --cross-rtt 2 --output benchmark/results/run.json
npm run benchmark:test
```

Each run builds the packages and two images, creates an isolated replica set,
checks all twelve directed network paths with ping, and alternates the driver
order. Each sample executes in a new Node process with a new client. The default
is 30 samples per driver per operation, or 120 fresh processes. The harness
removes its containers, network and certificate volume when it finishes or fails.
Do not run two copies concurrently; the Compose project and subnet are fixed.

The client and primary are in simulated AZ A; the secondaries are in AZ B and C.
The default injected RTT is 0.5 ms within AZ A and 2 ms across AZs. Each endpoint
adds half that delay to packets addressed to the peer, including replication
traffic. Real scheduling and processing overhead adds to the configured delay.
These are illustrative values, not measurements from AWS. AWS describes same-region
AZ networking as [single-digit millisecond latency](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_fault_isolation_multiaz_region_system.html).

Both clients perform the same indexed `findOne` on the primary, or an `insertOne`
with majority acknowledgement. Reads explicitly request the primary because the
wrapper otherwise selects a secondary. Data and topology are prepared before
sampling; the serverless client reads topology through LocalPlugin. TLS verifies
a generated CA and hostname. Certificates and benchmark-only credentials are
confined to the disposable Docker network; no database ports are published.

The normal MongoClient uses the full three-host replica-set URI. The serverless
wrapper rewrites that URI to the selected host with `directConnection=true` and
removes `replicaSet` before constructing its underlying MongoClient. The live test
checks the effective URI, resolved options, `Single` topology and socket targets
for both reads and writes. Connection records remove URI credentials.

The JSON contains effective connection URIs and topologies, individual samples,
timestamps, selected addresses, TLS status,
connection traces, configured and measured RTTs, versions and image identities.

## Timing boundaries

The total starts immediately before client construction and ends after the first
operation resolves. Imports, process launch, cluster setup and client close are
outside this interval. `connectCallMs` is diagnostic only: the wrapper's `connect()`
does not open a database connection.

The breakdown follows the application socket that served the operation:

| Phase | Boundary |
| --- | --- |
| TCP / DNS | `tls.connect()` call to the socket's `connect` event |
| TLS | TCP connect to `secureConnect` |
| Hello | Initial MongoDB handshake command, including speculative SCRAM authentication |
| Auth | SCRAM provider execution after hello, including computation and remaining exchanges |
| Send | Operation command entry to completion of the driver's socket-write method |
| Receive / wait | Socket-write completion to decoded command result; includes network, server execution and write acknowledgement |
| Other / discovery | Remaining elapsed time, including server selection, monitoring connections, plugin access, client construction and operation overhead |

Only application-socket phases are subtracted from total elapsed time. Discovery
sockets run in parallel and their durations must not be added together. Their
individual traces are retained in the JSON.

## Limitations

Send measures serialization and local socket writing, not arrival at the server.
Receive includes the round trip and server work; a client cannot distinguish
one-way transit from server execution. Hello and speculative authentication share
one exchange, so they cannot honestly be reported as independent durations.

Instrumentation wraps Node TLS and MongoDB connection/authentication methods in
the benchmark process. It does not edit either driver on disk. Those internal
hooks are checked against MongoDB 7.7.0 and deliberately reject another version.
Instrumentation itself adds some overhead, equally enabled for both clients.

The processes are fresh, but the database, OS caches and Docker VM are warm. There
is no Lambda sandbox provisioning, package-import timing, SRV DNS, remote topology
store, jitter, loss or bandwidth cap. This is a repeatable connection-latency
experiment rather than an AWS performance prediction. Default driver discovery
is allowed to complete as soon as it finds a suitable server; it is not forced to
wait for every replica member.

To render a run as Markdown, PNG and SVG, install the optional plotting dependency
in a virtual environment and pass the JSON to the report script:

```sh
python3 -m venv /tmp/mongodb-benchmark-plot
/tmp/mongodb-benchmark-plot/bin/pip install -r benchmark/requirements-report.txt
/tmp/mongodb-benchmark-plot/bin/python benchmark/report.py benchmark/results/latest.json --output benchmark/results/BASELINE.md
/tmp/mongodb-benchmark-plot/bin/python benchmark/test/report_test.py
```
