# Mini Benchmark

The MongoDB Serverless driver includes a small custom benchmark harness which attempts to replicate realistic latency for cold starts in a cloud environment for a single region replica set.

For documentation on the benchmark, see [README.md](benchmark/README.md).

## Execution

To run the benchmark and refresh the results here:
```sh
npm run benchmark -- --samples 48 --local-rtt 0.5 --cross-rtt 2 --output benchmark/results/repeat.json
python3 -m venv /tmp/mongodb-benchmark-plot
/tmp/mongodb-benchmark-plot/bin/pip install -r benchmark/requirements-report.txt
/tmp/mongodb-benchmark-plot/bin/python benchmark/report.py benchmark/results/repeat.json --output-dir benchmark/baseline
```

## Most Recent Results

### AWS Results

AWS results were collected on a sample application using the serverless client,
with MongoClient as the comparison.

[Raw samples](benchmark/aws/samples.json) · [Connection timings](benchmark/aws/connection-timings.json)

![AWS cold connection timeline](benchmark/aws/latency.png)

![Every AWS cold connection sample](benchmark/aws/samples.png)

Timings cover client construction through the completed operation and exclude
Lambda initialization.

![AWS connection phases](benchmark/aws/connection-phases.png)

### Local Results
\* These are local Docker measurements, not AWS Lambda cold-start measurements.

![Cold connection latency](benchmark/baseline/latency.png)

![Every cold connection sample](benchmark/baseline/samples.png)

![Operation latency](benchmark/baseline/results.png)

The results image includes differences in sample medians; positive means the wrapper took longer.

A single run does not establish a statistically significant performance difference.
The normal driver can select the local primary before discovery of remote members finishes.
The direct client also performs TCP, TLS, MongoDB handshake and authentication.

[Local results breakdown](benchmark/README.md#local-results-breakdown)
