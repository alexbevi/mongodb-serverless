# Cold connection benchmark

Compare MongoDB driver discovery with a serverless driver that connects directly
to a watcher-selected replica-set member. Each sample creates a fresh Node process,
constructs a client, and completes its first operation against a three-member
TLS replica set. The operation connects automatically; the benchmark does not
call `client.connect()` first.

See the [connection diagram and measured results](../BENCHMARK.md).

## Install

Use Node 20.19 or later, installed workspace dependencies, and Docker Compose with
`NET_ADMIN` and Linux `netem` support. No database ports are exposed to the host.

## Usage

```sh
npm run benchmark -- --no-monitoring --samples 48
npm run benchmark:test
pnpm lint
```

The command builds the harness and driver dependencies before starting Docker.
`run.ts` manages the cluster and launches `benchmark.ts` in a fresh process for each
cold sample. That entry point loads the topology and invokes `handler-read.ts` or
`handler-write.ts`. Each handler lazily creates a module-level client and retains
it for later invocations. `handler-base.ts` owns client configuration, event
listeners, measurement collection and cleanup. Clients close only when the
benchmark process finishes, not when a handler returns.

`--no-monitoring` includes the serverless driver with monitoring disabled, alongside
the MongoDB driver and a serverless control with monitoring enabled. Driver order
alternates. All results are verified; failures stop the run.

The MongoDB driver receives a `mongodb+srv` cluster URI. A local DNS service returns
three member addresses and the replica-set TXT record. Reads use
`secondaryPreferred`; writes use the default primary preference. The serverless
driver receives separate read and write member URIs with `directConnection=true`.
The read member is a secondary and the write member is the primary. The topology
snapshot is prepared outside the timed operation.

Both drivers perform an indexed `findOne` or a majority-acknowledged `updateOne`.
Authentication uses SCRAM-SHA-1 to match the measured Atlas account. TLS verifies
the generated CA and member hostname. Each pool allows one application connection
per member; retries are disabled. Socket traces record the member role and negotiated
authentication mechanism.

The client container has 1 GiB memory and a 0.579 CPU quota. This approximates the
CPU share associated with the default 1024 MB Lambda configuration; it does not
reproduce Lambda scheduling or processor speed. The JSON records actual cgroup limits.
The client and read secondary share simulated AZ B; the primary is in AZ A and
the other secondary is in AZ C. This models the measured AWS ordering, where a
secondary had the lowest warm network latency.
Default injected RTT is 0.5 ms within a zone and 2 ms between zones. These are added
delays, not total network latency. The run measures all twelve directed paths with
ping and saves the results. Override delays with `--local-rtt` and `--cross-rtt`.

Containers, generated images, network and certificate volume are removed on exit.
Docker build caches and base images remain. Do not run two copies concurrently:
the project name and subnet are fixed. After a forced termination, clean up with:

```sh
docker compose -f benchmark/docker/compose.yaml down --volumes --remove-orphans --rmi local
```

## Limitations

Timing starts immediately before handler invocation and ends when it returns,
including lazy client construction on the first call.
Process startup, imports, watcher work and client close are excluded. This boundary
is narrower than a complete Lambda cold start. The recorded samples are cold;
handler reuse is tested separately. Database processes and OS caches remain warm
across samples.

`secondaryPreferred` can fall back to a primary when no secondary is known.
Discovery does not wait for every monitor. The saved socket roles identify
where each operation actually ran.

Public events record connection creation/readiness, checkout start/success/failure,
check-in, connection closure, and command start/success/failure. Each callback
records `performance.now()` and connection metadata without command documents.
Pool events are matched by address and connection ID; command completion also
matches the request ID. Checkout pairing assumes this benchmark's serial
operations, not concurrent requests to a shared pool.

The JSON retains `applicationConnectionReadyMs`, `commandStartedMs` and
`readyToCommandMs`, plus `trace.events` and `trace.lifecycle` windows for connection
setup, checkouts, command execution and return to the handler caller. Setup and
checkout can overlap; their durations must not be added together.

The diagram colours only the portions of these windows outside the measured
TCP/TLS/hello/authentication and send/receive phases. Connection/pool gaps take
precedence over the ready-to-command interval, so each piece is counted once.
The new colours bound work in time; they do not distinguish CPU work from
scheduling delays. `summary.json` records the mean windows as `lifecycleMeanMs`
and the non-overlapping gap categories as `gapMeanMs`, including the remaining
unclassified time. Readiness includes discovery and authentication; it is not
the duration of a `connect()` call.

TCP timing includes hostname lookup and event-loop scheduling. Hello can include
speculative authentication. Send measures serialization and socket buffering;
receive includes network transit and server work. Internal gaps remain elapsed-time
residuals rather than a claim to identify every CPU activity. Instrumentation adds
some overhead and is verified against MongoDB driver 7.7.0.

The local DNS resolver, CPU quota, certificates, MongoDB deployment and network
scheduler differ from AWS. Local results test the connection sequence; they are
not an AWS latency prediction. Saved measurements live only in `results/local/`
and `results/aws/`. The [local report](../BENCHMARK.md) describes how to replace
the local samples, diagram and summary. The
[AWS results](results/aws/results.md) record a separate AWS run and its measurement date.
