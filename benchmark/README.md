# Cold connection benchmark

Compare MongoDB driver discovery with a serverless driver that connects directly
to a watcher-selected replica-set member. Each sample creates a fresh Node process,
constructs a client, connects, and completes one operation against a three-member
TLS replica set.

See the [connection diagram and measured results](../BENCHMARK.md#connection-selection-and-timings).

## Install

Use Node 20.19 or later, installed workspace dependencies, and Docker Compose with
`NET_ADMIN` and Linux `netem` support. No database ports are exposed to the host.

## Usage

```sh
npm run benchmark -- --no-monitoring --samples 48 --output benchmark/results/run.json
npm run benchmark:test
pnpm lint
```

The command builds the harness and driver dependencies before starting Docker.
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
authentication mechanism, including additional application connections if `connect()`
and the operation select different members.

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

Timing starts before client construction and ends when the operation returns.
Process startup, imports, watcher work and client close are excluded. This boundary
is narrower than a complete Lambda cold start. Database processes and OS caches
remain warm across samples.

`secondaryPreferred` can fall back to a primary when no secondary is known.
Discovery does not wait for every monitor. `connect()` and the operation select
independently, so a read can establish application connections to two members.
The saved socket roles identify where each operation actually ran.

TCP timing includes hostname lookup and event-loop scheduling. Hello can include
speculative authentication. Send measures serialization and socket buffering;
receive includes network transit and server work. Internal gaps remain elapsed-time
residuals rather than a claim to identify every CPU activity. Instrumentation adds
some overhead and is verified against MongoDB driver 7.7.0.

The local DNS resolver, CPU quota, certificates, MongoDB deployment and network
scheduler differ from AWS. Local results test the connection sequence; they are
not an AWS latency prediction. The historical charts in `baseline/` retain their original configurations.
The older `report.py` assumes one application connection and should only be used
with those historical datasets. Each plotted sample must show every socket it opened. If a diagram illustrates
a subset, label that subset and keep its sample timings distinct from all-sample means.
