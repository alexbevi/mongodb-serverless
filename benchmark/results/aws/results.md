# AWS connection benchmark

Measured on 15 October 2026 in `ap-southeast-2`, using AWS Lambda with 1024 MB
memory. This is a point-in-time result for that deployment and workload. It is
not necessarily representative of the current driver, application or AWS performance.
Local benchmark runs do not update these results. Future AWS runs replace the
data, diagram and report in this folder, keeping the same links.

![AWS connection timings from 15 October 2026](latency.png)

Mean read time was **253.1 → 200.5 ms (20.8% less time)**; mean write time was
**263.3 → 206.8 ms (21.5% less time)**.

Percentages use unrounded means. Each driver/operation has 30 verified cold Lambda
invocations. Timing starts before handler invocation, including lazy client construction,
and ends at the operation result;
imports, Lambda INIT, watcher work and client close are excluded.

AWS results were collected on a sample application using MongoDB driver 7.7.0
and serverless driver 0.2.0. The MongoDB driver used the cluster SRV URI and
`secondaryPreferred` for reads. The serverless driver used watcher-provided direct
secondary/read and primary/write URIs with monitoring disabled. Writes used
majority acknowledgement. MongoDB reads reached secondaries in 25 of 30 samples
and fell back to the primary in 5, as permitted by `secondaryPreferred` during
discovery. All serverless reads reached secondaries; all writes reached primaries.

Every serverless sample opened one authenticated application socket and no monitor
socket. Each illustrated trace is a real sample nearest its driver/operation
median, with every socket from that sample shown. The diagram headings
report means across all 30 samples per driver/operation.
Cluster DNS is the shared SRV/TXT discovery stage, shown as one block spanning
all three node lanes before sockets open. Its elapsed time averaged 15.79 ms for MongoDB reads and 13.33 ms for writes.
The requests overlap; their individual durations must not be added. Host DNS
segments show hostname resolution before TCP on each socket. For the selected
application socket, this averaged 13.80/7.05 ms for MongoDB reads/writes and
7.32/8.96 ms for serverless reads/writes. Direct clients skip cluster discovery
DNS but still resolve the member hostname. Detailed means are in `dnsMeanMs` in
the summary; individual requests are retained in `trace.dns`.

Magenta marks gaps within connection setup or pool checkout, teal marks the
remaining interval before command start, and pink marks time after command success.
These intervals exclude the measured socket phases and do not overlap.

Bar-end labels report the illustrated sample's duration. Overlapping monitor
durations must not be added.

Lambda placement, CPU scheduling, DNS, TLS and database load affect these timings.
The results do not establish current performance or the behavior of long-lived
pools, elections or failover.

The diagram separates Setup, Connection and Operation. Application phases take
precedence over concurrent monitor phases; overlapping monitor intervals count
once in the summary. `~` marks rounded values.

This run uses socket and client-event instrumentation without diagnostic code
probes or async-hook stack capture. Grey intervals retain measured elapsed time
whose internal cause was not profiled on Lambda. The [local diagnostic workflow](../../README.md#reading-the-diagram)
measures code scopes separately; its durations are not substituted into AWS bars.
The summary retains the unrounded accounting and interval boundaries.

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
