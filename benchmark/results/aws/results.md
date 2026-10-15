# AWS connection benchmark

Measured on 15 October 2026 in `ap-southeast-2`, using AWS Lambda with 1769 MB
memory. This is a point-in-time result for that deployment and workload. It is
not necessarily representative of the current driver, application or AWS performance.
Local benchmark runs do not update these results. Future AWS runs replace the
data, diagram and report in this folder, keeping the same links.

![AWS connection timings from 15 October 2026](latency.png)

Median read time was **261.3 → 212.4 ms (18.7% less time)**; median write time was
**285.0 → 210.5 ms (26.2% less time)**.

Percentages use unrounded medians. Each driver/operation has 120 verified cold Lambda
invocations, collected in four batches of 30. The complete run took approximately
8m 08s, including authentication, worker resets and logout. Timing starts before handler invocation, including lazy client construction,
and ends at the operation result;
imports, Lambda INIT, watcher work and client close are excluded.

AWS results were collected on a sample application using MongoDB driver 7.7.0
and serverless driver 0.2.0 on Node.js 24.21.0. Diagnostic probes were enabled. The MongoDB driver used the cluster SRV URI and
`secondary` for reads. The serverless driver used watcher-provided direct
secondary/read and primary/write URIs with monitoring disabled. Writes used
majority acknowledgement. Every read from both drivers reached a secondary; every write reached a primary.

Every serverless sample opened one authenticated application socket and no monitor
socket. Each illustrated trace is a real sample nearest its driver/operation
median, with every socket from that sample shown. The diagram headings
compare medians across all 120 samples per driver/operation.
Cluster DNS is the shared SRV/TXT discovery stage, shown as one block spanning
all three node lanes before sockets open. Its elapsed time averaged 11.57 ms for MongoDB reads and 10.45 ms for writes.
The requests overlap; their individual durations must not be added. Host DNS
segments show hostname resolution before TCP on each socket. For the selected
application socket, this averaged 8.88/3.82 ms for MongoDB reads/writes and
4.87/4.64 ms for serverless reads/writes. Direct clients skip cluster discovery
DNS but still resolve the member hostname. Detailed means are in `dnsMeanMs` in
the summary; individual requests are retained in `trace.dns`.

The diagram uses the same [code probes and legend definitions](../../README.md#reading-the-diagram)
as the local benchmark. Setup, connection and operation colours come from measured
code scopes, DNS/socket phases and callback/dispatch boundaries. Every invocation
has continuous execution coverage from handler invocation through its result;
there are no unclassified elapsed-time intervals. Remaining callback work is
labelled **Other callbacks**, without claiming to identify every instruction.

Hatching marks callbacks whose elapsed time exceeded their measured thread CPU
by at least 2 ms. The annotation beneath each client gives main-thread CPU and
cumulative callback time off CPU. Hatching covers the callback's interval; it does
not locate individual scheduling pauses or establish why the thread was off CPU.
Lambda cgroup counters were not collected.

Bar-end labels report the illustrated sample's duration. Overlapping monitor
durations must not be added.

Lambda placement, CPU scheduling, DNS, TLS and database load affect these timings.
The results do not establish current performance or the behavior of long-lived
pools, elections or failover.

The summary retains means, p95 and median absolute deviations (MAD), the typical
distance from the median. The mean reduction's 95% confidence interval uses 2,000
hierarchical bootstrap resamples: batches first, then paired five-worker rounds
within each batch. The batch range shows observed variation in mean reduction.
Four batches describe these runs; they do not establish performance across other
deployments or times of day.

The diagram separates Setup, Connection and Operation. Application phases take
precedence over concurrent monitor phases; overlapping monitor intervals count
once in the summary. `~` marks rounded values.

Recording overhead remains in the timings. Creation-stack capture alone took a
median **35.3 ms per invocation**, with a median share of **14.5%** of elapsed time.
That is too large to omit. The ordinary secondary-only
workers were deployed after collection; the CI performance gate remains unprofiled.

The raw JSON retains each code scope, callback/dispatch interval and thread CPU
measurement. Repeated creation stacks are stored once in `executionSources` and
referenced by `sourceId`; no timing segments are discarded.

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
