# Measured connection performance

The benchmark records the first read or write in a cold Lambda execution
environment. Each invocation retrieves its connection string from SSM SecureString.
It measures native MongoDB, the serverless driver without a plugin, and the
serverless driver using topology cached in SSM.

- [LocalStack measurements](benchmark/results/local/results.md)
- [AWS Lambda measurements](benchmark/results/aws/results.md)
- [Run the benchmark](benchmark/LAMBDA.md)

![AWS connection breakdown](benchmark/results/aws/latency.png)

Each report states the measurement date, environment, sample counts, and timing
scope. Charts show individual traces nearest cohort medians, including SSM,
all MongoDB connections, discovery, authentication, role checks, the operation,
and measured code and callback time. Concurrent socket lanes overlap; their
elapsed times must not be added.

These are the last measured results. They describe the recorded runtime, cluster,
and workload, including diagnostic overhead. LocalStack latency does not predict
AWS latency. Lambda INIT and client close are outside the primary measurement.
