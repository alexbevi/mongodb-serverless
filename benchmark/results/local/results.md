# LocalStack 4.14.0 results

Measured 2026-10-19T13:52:35.300Z · Node v24.21.0.

40 cold invocations per driver/operation case.

| Operation / pattern | n | Handler median | Handler p95 | INIT median | SSM median | INIT + handler median |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 40 | 50.7 ms | 54.2 ms | 163.9 ms | 19.3 ms | 215.2 ms |
| read / No plugin | 40 | 53.9 ms | 56.3 ms | 164.0 ms | 19.3 ms | 218.2 ms |
| read / aws-ssm · cached topology | 40 | 44.7 ms | 46.9 ms | 164.3 ms | 19.7 ms | 208.8 ms |
| write / Native MongoDB | 40 | 51.7 ms | 54.5 ms | 163.8 ms | 19.2 ms | 215.6 ms |
| write / No plugin | 40 | 67.2 ms | 69.9 ms | 163.8 ms | 19.2 ms | 230.4 ms |
| write / aws-ssm · cached topology | 40 | 45.3 ms | 48.3 ms | 165.2 ms | 19.6 ms | 210.5 ms |
| No plugin / lucky write, 1 connection | 10 | 54.9 ms | 56.6 ms | 164.4 ms | 19.2 ms | 218.9 ms |
| No plugin / write, 2 connections | 30 | 68.1 ms | 70.0 ms | 163.8 ms | 19.3 ms | 231.6 ms |

SSM is fetched during INIT. Handler latency starts after that fetch and ends at the operation result. INIT + handler is calculated per invocation before taking the median. The client is created lazily and retained for warm calls.

INIT includes runtime and module initialization. Provisioning, caller transport, and post-result reporting are outside the measured interval. Detailed probes add overhead. Write landing groups occur naturally and have unequal sample counts.

LocalStack omits INIT duration from its log tail. INIT here measures the Node performance clock from process startup until module initialization completes. It excludes container provisioning and is not AWS-reported INIT.

Deployment package: 4,995,900 bytes ZIP; identical for all patterns, including both drivers and diagnostic probes.

6 separate warm checks verified environment and client reuse, without further SSM requests, cluster DNS or discovery. Serverless calls reused their direct sockets. A native nearest read may open a pool connection to another member.

| Warm check | Handler time | Serving role |
|---|---:|---|
| read / Native MongoDB | 4.8 ms | SECONDARY |
| write / Native MongoDB | 4.8 ms | PRIMARY |
| read / No plugin | 4.2 ms | SECONDARY |
| write / No plugin | 4.6 ms | PRIMARY |
| read / aws-ssm · cached topology | 4.3 ms | SECONDARY |
| write / aws-ssm · cached topology | 5.3 ms | PRIMARY |

One warm invocation per case validates reuse; these timings are not a warm latency distribution.

![Measured connection breakdown](latency.png)

Each panel shows a real invocation nearest its cohort median of INIT + handler time. INIT and its SSM request are shown above the handler detail. Each socket has its own row; DNS and other work have separate rows. Parallel rows must not be added. The summary accounts for every measured millisecond once.
