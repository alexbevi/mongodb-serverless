# Cold connection baseline

Measured 2026-10-09T17:13:35.685Z using harness commit `49d5cbdc44a65f7a21b78a6e2b2368ff6b5bac16` with local changes.

48 fresh Node processes per driver and operation (192 samples total).
The timer covers client construction through the first completed operation.
These are local Docker measurements, not AWS Lambda cold-start measurements.

![Cold connection latency](benchmark/baseline/latency.png)

## Results

![Every cold connection sample](benchmark/baseline/samples.png)

| Operation | Client | Median (ms) | p95 (ms) | Mean (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| Read | MongoClient | 65.97 | 112.78 | 71.93 | 54.83–145.22 |
| Read | ServerlessMongoClient | 68.71 | 125.39 | 77.30 | 58.06–226.33 |
| Write | MongoClient | 73.09 | 156.19 | 82.38 | 59.28–326.35 |
| Write | ServerlessMongoClient | 71.94 | 120.94 | 78.16 | 59.09–159.85 |

Differences in sample medians (positive means the wrapper took longer):

- Read: +2.74 ms (+4.1%).
- Write: -1.14 ms (-1.6%).

A single run does not establish a statistically significant performance difference.
The normal driver can select the local primary before discovery of remote members finishes.
The direct client also performs TCP, TLS, MongoDB handshake and authentication.

### Seed order

The native client cycles through all six seed permutations. The serverless client uses one selected host and has no seed-order treatment; which client runs first is reversed on the next six-order cycle.

An explicit `mongodb://` URI supplies an ordered seed list. DNS SRV answers can arrive in a
different order, but this benchmark does not perform SRV discovery. Varying the explicit
list measures sensitivity to launch order; it does not simulate DNS lookup latency.

### How members are discovered and connected

The native client starts with all three addresses already in its seed URI:
`mongo-a:27017,mongo-b:27017,mongo-c:27017`, with `replicaSet=benchmark`.
It starts monitoring connections to all three; their TCP, TLS and initial hello exchanges
overlap. The extra lanes show those exchanges at their measured offsets, not extra latency.

Each hello describes the responding member and replica-set membership. In replica-set mode,
the driver uses these replies to identify the primary, discover additional members and
update its topology. A seed list can contain only part of the set: discovered addresses
then receive their own monitors. This benchmark supplies all three seeds up front.

The native client does not know roles from seed order: the primary’s own hello must establish
its role before it becomes selectable. The diagram marks this as Primary confirmed.
The driver then opens and authenticates an application connection
to it. It need not wait for both secondary monitors. A pool exists for each known server,
but with `minPoolSize=0` this run opens no application connections to the unused secondaries.

The wrapper reads topology prepared by `replSetGetStatus` before timing, selects `mongo-a`,
and creates a one-host client with `directConnection=true`. That client still monitors
and authenticates separate connections to `mongo-a`, but does not follow the hello member
list to open connections to `mongo-b` or `mongo-c`.

See the [MongoDB discovery specification](https://specifications.readthedocs.io/en/latest/server-discovery-and-monitoring/server-discovery-and-monitoring/).

### Connection start and ready times

Both clients first open a monitoring connection to the selected host and wait for its hello.
They then open a separate application connection, complete TLS, hello and authentication,
and execute the command. Direct connection mode still performs both connections.

All times below are means in milliseconds, relative to client construction. Connection 1
ends when its initial hello returns; its monitoring socket remains open. Connection 2
is ready when authentication finishes. These are setup durations, not socket lifetimes.

| Client / operation | 1: start | 1: hello complete | 1: duration | 2: start | 2: authenticated | 2: duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MongoClient / read | 20.01 | 40.24 | 20.23 | 42.09 | 65.30 | 23.22 |
| ServerlessMongoClient / read | 19.84 | 44.88 | 25.04 | 46.68 | 70.18 | 23.50 |
| MongoClient / write | 23.85 | 45.95 | 22.09 | 48.00 | 71.40 | 23.40 |
| ServerlessMongoClient / write | 19.75 | 42.20 | 22.45 | 43.83 | 67.24 | 23.41 |

### Where the former Other / discovery time went

The original chart subtracted only application-socket phases. It therefore put the entire
initial monitoring connection in Other. The saved traces recover the intervals below
without rerunning the benchmark. Remaining gaps are measured intervals, not CPU profiles.

| Client / operation | Before monitoring | Monitoring connection | Between connections | Remaining application / command gaps | Former Other |
| --- | ---: | ---: | ---: | ---: | ---: |
| MongoClient / read | 20.01 | 20.23 | 1.84 | 4.71 | 46.80 |
| ServerlessMongoClient / read | 19.84 | 25.04 | 1.81 | 5.21 | 51.89 |
| MongoClient / write | 23.85 | 22.09 | 2.05 | 4.32 | 52.31 |
| ServerlessMongoClient / write | 19.75 | 22.45 | 1.62 | 4.30 | 48.13 |

### Native client by seed order

The serverless client has no seed-order treatment: it chooses one host from the supplied topology.

| Native seed order | Operation | Samples | Mean total (ms) |
| --- | --- | ---: | ---: |
| mongo-a → mongo-b → mongo-c | read | 8 | 66.65 |
| mongo-a → mongo-b → mongo-c | write | 8 | 73.19 |
| mongo-a → mongo-c → mongo-b | read | 8 | 75.98 |
| mongo-a → mongo-c → mongo-b | write | 8 | 89.08 |
| mongo-b → mongo-a → mongo-c | read | 8 | 84.82 |
| mongo-b → mongo-a → mongo-c | write | 8 | 68.76 |
| mongo-b → mongo-c → mongo-a | read | 8 | 63.44 |
| mongo-b → mongo-c → mongo-a | write | 8 | 71.15 |
| mongo-c → mongo-a → mongo-b | read | 8 | 74.19 |
| mongo-c → mongo-a → mongo-b | write | 8 | 103.66 |
| mongo-c → mongo-b → mongo-a | read | 8 | 66.50 |
| mongo-c → mongo-b → mongo-a | write | 8 | 88.44 |

Before monitoring includes client configuration, CA-file reading and topology setup;
the wrapper also prepares routing. The traces do not separate those costs. Between
connections covers the transition from the monitor reply to starting the application socket.
The remaining gaps occur between connection phases, before command dispatch and on return.

### Mean connection phases

The timeline places these phases inside the two outlined connection intervals.
The chart uses means so sequential segments add to mean total time; medians do not.

| Client / operation | Connection | TCP / DNS | TLS | Hello | Remaining auth | Gaps | Total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MongoClient / read | 1: monitor | 7.76 | 4.48 | 6.80 | — | 1.19 | 20.23 |
| MongoClient / read | 2: application | 4.76 | 3.67 | 3.63 | 9.79 | 1.37 | 23.22 |
| ServerlessMongoClient / read | 1: monitor | 10.77 | 5.92 | 6.82 | — | 1.52 | 25.04 |
| ServerlessMongoClient / read | 2: application | 3.77 | 3.80 | 3.65 | 10.86 | 1.41 | 23.50 |
| MongoClient / write | 1: monitor | 8.40 | 4.83 | 7.61 | — | 1.26 | 22.09 |
| MongoClient / write | 2: application | 4.77 | 3.49 | 3.31 | 10.46 | 1.37 | 23.40 |
| ServerlessMongoClient / write | 1: monitor | 10.23 | 4.69 | 6.27 | — | 1.26 | 22.45 |
| ServerlessMongoClient / write | 2: application | 3.63 | 3.63 | 3.62 | 11.18 | 1.34 | 23.41 |

### Mean timeline segments

| Client / operation | Before monitoring | 1. Monitoring connection | Between connections | 2. Application connection | Before command | Send / buffer | Receive / wait | Return to caller |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MongoClient / read | 20.01 | 20.23 | 1.84 | 23.22 | 2.56 | 0.51 | 2.77 | 0.78 |
| ServerlessMongoClient / read | 19.84 | 25.04 | 1.81 | 23.50 | 2.99 | 0.53 | 2.79 | 0.81 |
| MongoClient / write | 23.85 | 22.09 | 2.05 | 23.40 | 2.30 | 0.56 | 7.48 | 0.65 |
| ServerlessMongoClient / write | 19.75 | 22.45 | 1.62 | 23.41 | 2.26 | 0.60 | 7.36 | 0.70 |

## Network and workload

The client and primary share simulated AZ A; two secondaries occupy AZ B and C. Injected RTT is 0.5 ms within AZ A and 2 ms across AZs, split equally between packet directions.
Measured RTTs below include Docker VM scheduling overhead. These are illustrative same-region
values; AWS describes [single-digit millisecond AZ networking](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_fault_isolation_multiaz_region_system.html).

| Source | Destination | Injected RTT (ms) | Measured ping mean (ms) |
| --- | --- | ---: | ---: |
| client | mongo-a | 0.50 | 1.98 |
| client | mongo-b | 2.00 | 4.18 |
| client | mongo-c | 2.00 | 3.77 |
| mongo-a | client | 0.50 | 1.91 |
| mongo-a | mongo-b | 2.00 | 3.83 |
| mongo-a | mongo-c | 2.00 | 4.19 |
| mongo-b | client | 2.00 | 3.75 |
| mongo-b | mongo-a | 2.00 | 3.98 |
| mongo-b | mongo-c | 2.00 | 4.51 |
| mongo-c | client | 2.00 | 4.50 |
| mongo-c | mongo-a | 2.00 | 4.07 |
| mongo-c | mongo-b | 2.00 | 3.96 |

- MongoClient uses the three-member seed URI. The wrapper rewrites it to one selected host with `directConnection=true` and removes `replicaSet`.
- Both use verified TLS, SCRAM-SHA-256, a one-connection pool and no retries.
- Read: indexed `findOne` of an existing document on the primary. Write: one small `insertOne`, with majority acknowledgement.
- Every result is checked. Driver order alternates within read/write pairs. No failures are discarded.
- Topology is populated before timing; LocalPlugin reads its JSON from the process environment.
- CPU scheduling, filesystem caches, database caches and the Docker VM remain warm.

A [historical live connection check](benchmark/baseline/connection-check.json) records the
effective URIs, resolved options, topology types and socket destinations from the earlier fixed-order run for both
operations. The wrapper used `Single` topology and contacted only `mongo-a`; the
normal client used `ReplicaSetWithPrimary` and contacted all three members.

## Measurement limits

TCP includes DNS; TLS is timed between TCP connect and secureConnect. Hello includes speculative
authentication; Auth covers the remaining SCRAM provider work. Send measures serialization and
socket buffering, not one-way network delivery. Receive/wait includes network transit, server
execution, acknowledgement and decoding. Server execution is not measured separately.

The timeline includes the selected host’s initial monitoring and application connections.
Other members are monitored concurrently; their durations are retained in the raw traces
and shown in parallel lanes, but are not added to total elapsed time. Instrumentation runs in the benchmark process
and leaves both driver implementations unchanged.

Process launch, package imports, Lambda sandbox initialization, SRV DNS and fetching topology
from a remote store are excluded. No jitter, loss or bandwidth cap is injected.

## Reproduce

```sh
npm run benchmark -- --samples 48 --local-rtt 0.5 --cross-rtt 2 --output benchmark/results/repeat.json
python3 -m venv /tmp/mongodb-benchmark-plot
/tmp/mongodb-benchmark-plot/bin/pip install -r benchmark/requirements-report.txt
/tmp/mongodb-benchmark-plot/bin/python benchmark/report.py benchmark/results/repeat.json --output benchmark/results/BASELINE.md
```

[Raw samples](benchmark/baseline/samples.json) · [Recovered connection timings](benchmark/baseline/connection-timings.json) · [SVG plot](benchmark/baseline/latency.svg) · [Harness and phase definitions](benchmark/README.md)

## Environment

- Node: `v24.18.0`; MongoDB driver: `7.7.0`.
- MongoDB: `db version v8.0.32`.
- Client kernel: `Linux c12f760aa177 6.12.76-linuxkit #1 SMP Sun Mar  8 14:41:59 UTC 2026 aarch64 GNU/Linux`.
- Docker Engine: `29.3.1`.
- Image identities and complete version metadata are included in the raw samples.

Database credentials and generated certificate keys are not included in the results.
