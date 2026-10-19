# LocalStack 4.14.0 results

Measured 2026-10-19T02:22:03.776Z · Node v24.21.0.

40 cold invocations per driver/operation case.

| Operation / pattern | n | Median | p95 | SSM median | Median excluding SSM |
|---|---:|---:|---:|---:|---:|
| read / Native MongoDB | 40 | 53.5 ms | 57.4 ms | 18.4 ms | 34.9 ms |
| read / No plugin | 40 | 55.0 ms | 62.6 ms | 18.5 ms | 36.6 ms |
| read / SSM topology plugin | 40 | 49.2 ms | 52.7 ms | 18.1 ms | 30.9 ms |
| write / Native MongoDB | 40 | 53.6 ms | 60.1 ms | 18.5 ms | 35.2 ms |
| write / No plugin | 40 | 63.5 ms | 66.7 ms | 18.1 ms | 45.7 ms |
| write / SSM topology plugin | 40 | 49.8 ms | 53.6 ms | 18.3 ms | 31.5 ms |
| No plugin / lucky write, 1 connection | 10 | 56.9 ms | 58.6 ms | 18.6 ms | 38.3 ms |
| No plugin / write, 2 connections | 30 | 64.1 ms | 67.1 ms | 18.0 ms | 46.0 ms |

Timings include SSM through the operation result; Lambda INIT and client close are separate. Write landing groups occur naturally and have unequal sample counts.

![Measured connection breakdown](latency.png)

Each panel shows a measured trace nearest its cohort median. The timeline accounts for SSM, DNS, all MongoDB connections, authentication, discovery, role validation, the operation, measured code scopes, and callback/dispatch time. Parallel socket lanes overlap and must not be added. Detailed probes add overhead. Each SSM-excluded value is calculated per sample before taking the median; it is not a subtraction of cohort medians.
