# Cold connection baseline

Measured 2026-10-09T15:22:49.392Z using harness commit `706abdf9f96e1421c2b96bd03a51c47cfd7599ae`.

50 fresh Node processes per driver and operation (200 samples total).
The timer covers client construction through the first completed operation.
These are local Docker measurements, not AWS Lambda cold-start measurements.

![Cold connection latency](benchmark/baseline/latency.png)

## Results

| Operation | Client | Median (ms) | p95 (ms) | Mean (ms) | Range (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| Read | MongoClient | 42.38 | 44.65 | 42.27 | 38.07–45.37 |
| Read | ServerlessMongoClient | 43.26 | 45.24 | 43.35 | 38.15–46.01 |
| Write | MongoClient | 46.10 | 48.00 | 46.14 | 43.18–48.52 |
| Write | ServerlessMongoClient | 47.46 | 50.14 | 47.49 | 44.26–50.88 |

Differences in sample medians (positive means the wrapper took longer):

- Read: +0.88 ms (+2.1%).
- Write: +1.36 ms (+3.0%).

A single run does not establish a statistically significant performance difference.
The normal driver can select the local primary before discovery of remote members finishes.
The direct client also performs TCP, TLS, MongoDB handshake and authentication.

### Mean phase timings

The stacked chart uses means so its segments add to mean elapsed time. Medians of individual
phases do not generally add to the median total. All values below are milliseconds.

| Client / operation | TCP / DNS | TLS | Hello + speculative auth | Remaining auth | Send / buffer | Receive / wait | Other / discovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MongoClient / read | 3.05 | 3.34 | 2.36 | 5.70 | 0.23 | 2.59 | 25.00 |
| ServerlessMongoClient / read | 2.92 | 3.26 | 2.74 | 5.91 | 0.25 | 2.75 | 25.52 |
| MongoClient / write | 3.00 | 3.40 | 2.30 | 5.82 | 0.27 | 6.60 | 24.75 |
| ServerlessMongoClient / write | 3.01 | 3.35 | 2.68 | 5.87 | 0.27 | 6.80 | 25.52 |

## Network and workload

The client and primary share simulated AZ A; two secondaries occupy AZ B and C. Injected RTT is 0.5 ms within AZ A and 2 ms across AZs, split equally between packet directions.
Measured RTTs below include Docker VM scheduling overhead. These are illustrative same-region
values; AWS describes [single-digit millisecond AZ networking](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_fault_isolation_multiaz_region_system.html).

| Source | Destination | Injected RTT (ms) | Measured ping mean (ms) |
| --- | --- | ---: | ---: |
| client | mongo-a | 0.50 | 2.60 |
| client | mongo-b | 2.00 | 3.81 |
| client | mongo-c | 2.00 | 3.93 |
| mongo-a | client | 0.50 | 2.01 |
| mongo-a | mongo-b | 2.00 | 3.65 |
| mongo-a | mongo-c | 2.00 | 3.75 |
| mongo-b | client | 2.00 | 4.08 |
| mongo-b | mongo-a | 2.00 | 4.21 |
| mongo-b | mongo-c | 2.00 | 4.68 |
| mongo-c | client | 2.00 | 3.74 |
| mongo-c | mongo-a | 2.00 | 4.00 |
| mongo-c | mongo-b | 2.00 | 3.87 |

- MongoClient uses the three-member seed URI. The wrapper rewrites it to one selected host with `directConnection=true` and removes `replicaSet`.
- Both use verified TLS, SCRAM-SHA-256, a one-connection pool and no retries.
- Read: indexed `findOne` of an existing document on the primary. Write: one small `insertOne`, with majority acknowledgement.
- Every result is checked. Driver order alternates within read/write pairs. No failures are discarded.
- Topology is populated before timing; LocalPlugin reads its JSON from the process environment.
- CPU scheduling, filesystem caches, database caches and the Docker VM remain warm.

A [follow-up live connection check](benchmark/baseline/connection-check.json) records the
effective URIs, resolved options, topology types and socket destinations for both
operations. The wrapper used `Single` topology and contacted only `mongo-a`; the
normal client used `ReplicaSetWithPrimary` and contacted all three members.

## Measurement limits

TCP includes DNS; TLS is timed between TCP connect and secureConnect. Hello includes speculative
authentication; Auth covers the remaining SCRAM provider work. Send measures serialization and
socket buffering, not one-way network delivery. Receive/wait includes network transit, server
execution, acknowledgement and decoding. Other/discovery is the residual elapsed time.

Phases describe only the application socket. Concurrent discovery socket durations are retained
in the raw traces but are not added to the total. Instrumentation runs in the benchmark process
and leaves both driver implementations unchanged.

Process launch, package imports, Lambda sandbox initialization, SRV DNS and fetching topology
from a remote store are excluded. No jitter, loss or bandwidth cap is injected.

## Reproduce

```sh
npm run benchmark -- --samples 50 --local-rtt 0.5 --cross-rtt 2 --output benchmark/results/repeat.json
python3 -m venv /tmp/mongodb-benchmark-plot
/tmp/mongodb-benchmark-plot/bin/pip install -r benchmark/requirements-report.txt
/tmp/mongodb-benchmark-plot/bin/python benchmark/report.py benchmark/results/repeat.json --output benchmark/results/BASELINE.md
```

[Raw samples](benchmark/baseline/samples.json) · [SVG plot](benchmark/baseline/latency.svg) · [Harness and phase definitions](benchmark/README.md)

## Environment

- Node: `v24.18.0`; MongoDB driver: `7.7.0`.
- MongoDB: `db version v8.0.32`.
- Client kernel: `Linux 0bb80a2d9291 6.12.76-linuxkit #1 SMP Sun Mar  8 14:41:59 UTC 2026 aarch64 GNU/Linux`.
- Docker Engine: `29.3.1`.
- Image identities and complete version metadata are included in the raw samples.

Database credentials and generated certificate keys are not included in the results.
