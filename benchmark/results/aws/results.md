# AWS connection benchmark

Measured on 15 October 2026 in `ap-southeast-2`, using AWS Lambda with 1024 MB
memory. This is a point-in-time result for that deployment and workload. It is
not necessarily representative of the current driver, application or AWS performance.
Local benchmark runs do not update these results. Future AWS runs replace the
data, diagram and report in this folder, keeping the same links.

![AWS connection timings from 15 October 2026](latency.png)

**Read comparison:** the diagram illustrates a real sample with one application
connection, but the 29.5% headline includes all reads. In 20 of 30 MongoDB reads,
`connect()` and `findOne()` selected different members and opened two application
connections. The 10 one-connection reads averaged 244.7 ms, compared with 204.7 ms
across all serverless reads: a 16.4% reduction. Including the two-connection reads
raises the MongoDB mean to 290.3 ms, so that behavior accounts for roughly half
the observed read-time gap. This subgroup comparison does not isolate the causal
cost of the extra connection. Writes used one application connection and showed
a 16.5% reduction.

| Operation | MongoDB mean | Serverless mean | Reduction |
| --- | ---: | ---: | ---: |
| Read | 290.3 ms | 204.7 ms | 29.5% |
| Write | 261.7 ms | 218.4 ms | 16.5% |

Percentages use unrounded means. Each driver/operation has 30 verified cold Lambda
invocations. Timing starts at client construction and ends at the operation result;
imports, Lambda INIT, watcher work and client close are excluded.

AWS results were collected on a sample application using MongoDB driver 7.7.0
and serverless driver 0.2.0. The MongoDB driver used the cluster SRV URI and
`secondaryPreferred` for reads. The serverless driver used watcher-provided direct
secondary/read and primary/write URIs with monitoring disabled. Writes used
majority acknowledgement. All reads in this cohort reached secondaries; all
writes reached primaries.

Every serverless sample opened one authenticated application socket and no monitor
socket. Each illustrated trace is a real sample
nearest the median within its single-application-connection subset, with every
socket from that sample shown. The table and diagram headings still report means
across all 30 samples per driver/operation, including the two-connection reads.
Bar-end labels report the illustrated sample's duration. Overlapping monitor
durations must not be added.

Lambda placement, CPU scheduling, DNS, TLS and database load affect these timings.
The results do not establish current performance or the behavior of long-lived
pools, elections or failover.

[Raw samples](samples.json) · [Summary statistics](summary.json) ·
[Current local benchmark](../../../BENCHMARK.md)

Infrastructure hostnames are replaced with stable member labels, and request,
round and environment identifiers are omitted. Timings, roles, sample order and
cold-start evidence are retained.

To redraw this snapshot from its saved data, run from the repository root with
the [report dependencies](../../requirements-report.txt) installed:

```sh
python3 benchmark/report.py benchmark/results/aws/samples.json --environment aws
```
