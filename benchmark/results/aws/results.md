# AWS Lambda results

Measured 2026-10-19T02:27:46.858Z · Node v24.21.0.

100 cold invocations per driver/operation case.

| Operation / pattern | n | Median | p95 | SSM median | Median excluding SSM |
|---|---:|---:|---:|---:|---:|
| read / Native MongoDB | 100 | 352.5 ms | 385.9 ms | 120.9 ms | 222.8 ms |
| read / No plugin | 100 | 329.3 ms | 379.6 ms | 118.4 ms | 211.4 ms |
| read / SSM topology plugin | 100 | 300.5 ms | 342.7 ms | 126.1 ms | 171.9 ms |
| write / Native MongoDB | 100 | 350.4 ms | 408.8 ms | 120.8 ms | 228.2 ms |
| write / No plugin | 100 | 394.4 ms | 461.3 ms | 120.2 ms | 280.5 ms |
| write / SSM topology plugin | 100 | 304.3 ms | 342.7 ms | 123.3 ms | 177.4 ms |
| No plugin / lucky write, 1 connection | 32 | 340.7 ms | 387.4 ms | 119.7 ms | 216.5 ms |
| No plugin / write, 2 connections | 68 | 414.0 ms | 465.4 ms | 121.1 ms | 290.9 ms |

| Pattern | Median INIT | Median INIT + measured interval |
|---|---:|---:|
| read / No plugin | 509.5 ms | 840.3 ms |
| read / SSM topology plugin | 517.1 ms | 812.9 ms |
| write / No plugin | 511.9 ms | 916.4 ms |
| write / SSM topology plugin | 519.4 ms | 811.4 ms |

INIT + measured interval excludes Lambda provisioning, invocation transport, and close. All variants load the same benchmark package.

Timings include SSM through the operation result; Lambda INIT and client close are separate. Write landing groups occur naturally and have unequal sample counts.

![Measured connection breakdown](latency.png)

Each panel shows a measured trace nearest its cohort median. The timeline accounts for SSM, DNS, all MongoDB connections, authentication, discovery, role validation, the operation, measured code scopes, and callback/dispatch time. Parallel socket lanes overlap and must not be added. Detailed probes add overhead. Each SSM-excluded value is calculated per sample before taking the median; it is not a subtraction of cohort medians.
