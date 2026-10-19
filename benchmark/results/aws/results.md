# AWS Lambda results

Measured 2026-10-19T14:00:40.948Z · Node v24.21.0.

100 cold invocations per driver/operation case.

| Operation / pattern | n | Handler median | Handler p95 | INIT median | SSM median | INIT + handler median |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 100 | 227.1 ms | 246.0 ms | 693.3 ms | 85.3 ms | 921.9 ms |
| read / No plugin | 100 | 204.5 ms | 236.3 ms | 586.7 ms | 81.5 ms | 789.9 ms |
| read / aws-ssm · cached topology | 100 | 170.5 ms | 200.5 ms | 598.2 ms | 85.8 ms | 761.6 ms |
| write / Native MongoDB | 100 | 221.4 ms | 262.0 ms | 593.8 ms | 82.2 ms | 815.5 ms |
| write / No plugin | 100 | 269.6 ms | 330.7 ms | 608.6 ms | 82.0 ms | 891.9 ms |
| write / aws-ssm · cached topology | 100 | 168.9 ms | 201.9 ms | 588.7 ms | 85.4 ms | 759.3 ms |
| No plugin / lucky write, 1 connection | 35 | 209.1 ms | 270.8 ms | 608.8 ms | 79.8 ms | 801.4 ms |
| No plugin / write, 2 connections | 65 | 290.9 ms | 331.6 ms | 608.3 ms | 82.1 ms | 895.2 ms |

SSM is fetched during INIT. Handler latency starts after that fetch and ends at the operation result. INIT + handler is calculated per invocation before taking the median. The client is created lazily and retained for warm calls.

INIT includes runtime and module initialization. Provisioning, caller transport, and post-result reporting are outside the measured interval. Detailed probes add overhead. Write landing groups occur naturally and have unequal sample counts.

Deployment package: 4,995,900 bytes ZIP; identical for all patterns, including both drivers and diagnostic probes.

6 separate warm checks verified environment and client reuse, without further SSM requests, cluster DNS or discovery. Serverless calls reused their direct sockets. A native nearest read may open a pool connection to another member.

| Warm check | Handler time | Serving role |
|---|---:|---|
| read / Native MongoDB | 61.3 ms | SECONDARY |
| write / Native MongoDB | 54.5 ms | PRIMARY |
| read / No plugin | 9.3 ms | PRIMARY |
| write / No plugin | 13.1 ms | PRIMARY |
| read / aws-ssm · cached topology | 11.4 ms | SECONDARY |
| write / aws-ssm · cached topology | 14.4 ms | PRIMARY |

One warm invocation per case validates reuse; these timings are not a warm latency distribution.

![Measured connection breakdown](latency.png)

Each panel shows a real invocation nearest its cohort median of INIT + handler time. INIT and its SSM request are shown above the handler detail. Each socket has its own row; DNS and other work have separate rows. Parallel rows must not be added. The summary accounts for every measured millisecond once.
