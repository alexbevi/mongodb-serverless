# LocalStack 4.14.0 results

Measured 2026-10-19T19:01:58.376Z · Node v24.21.0.

| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 40 | 23.9 | 23.6 | 1.3 | 25.3 | 23.5–24.4 |
| read / No plugin | 40 | 25.6 | 25.7 | 1.1 | 27.3 | 25.3–26.0 |
| read / aws-ssm · cached topology | 40 | 21.9 | 21.9 | 1.0 | 23.3 | 21.6–22.2 |
| write / Native MongoDB | 40 | 24.9 | 24.6 | 1.5 | 26.9 | 24.5–25.4 |
| write / No plugin | 40 | 29.9 | 30.6 | 2.9 | 34.6 | 29.0–30.8 |
| write / aws-ssm · cached topology | 40 | 22.5 | 22.4 | 1.1 | 24.3 | 22.2–22.9 |
| No plugin / lucky write, 1 connection | 12 | 26.1 | 26.1 | 0.8 | 27.2 | 25.7–26.5 |
| No plugin / write, 2 connections | 28 | 31.5 | 31.3 | 1.6 | 35.0 | 31.0–32.1 |

### Average read phase times

| Phase | Native MongoDB (n=40) | No plugin (n=40) | aws-ssm · cached topology (n=40) |
|---|---:|---:|---:|
| Cluster DNS · SRV + TXT | 0.3 | 1.3 | 0.0 |
| Monitor handshakes · overlapping time counted once | 7.9 | 0.0 | 0.0 |
| Application host DNS | 0.9 | 0.3 | 0.3 |
| TCP connection | 0.3 | 0.2 | 0.2 |
| TLS handshake | 1.0 | 1.6 | 1.6 |
| Initial hello | 0.7 | 2.1 | 2.1 |
| Authentication | 3.4 | 3.4 | 3.3 |
| Topology discovery | 0.0 | 0.7 | 0.0 |
| Additional hello commands | 0.0 | 0.7 | 0.0 |
| Prepare/send operation | 0.3 | 0.1 | 0.3 |
| Operation request → reply | 0.4 | 0.4 | 0.5 |
| Other handler work / scheduling | 8.7 | 14.9 | 13.6 |
| **Total** | **23.9** | **25.6** | **21.9** |

### Average write phase times

| Phase | Native MongoDB (n=40) | No plugin (n=40) | No plugin · lucky (n=12) | No plugin · 2 connections (n=28) | aws-ssm · cached topology (n=40) |
|---|---:|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 0.3 | 1.3 | 1.3 | 1.3 | 0.0 |
| Monitor handshakes · overlapping time counted once | 8.4 | 0.0 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 0.4 | 0.5 | 0.3 | 0.5 | 0.3 |
| TCP connection | 0.2 | 0.4 | 0.2 | 0.4 | 0.2 |
| TLS handshake | 1.0 | 2.4 | 1.6 | 2.7 | 1.6 |
| Initial hello | 0.7 | 2.6 | 2.2 | 2.8 | 2.2 |
| Authentication | 3.4 | 3.9 | 3.3 | 4.1 | 3.3 |
| Topology discovery | 0.0 | 0.7 | 0.7 | 0.7 | 0.0 |
| Additional hello commands | 0.0 | 0.7 | 0.7 | 0.7 | 0.0 |
| Prepare/send operation | 0.3 | 0.1 | 0.1 | 0.1 | 0.3 |
| Operation request → reply | 1.4 | 1.3 | 1.4 | 1.3 | 1.5 |
| Other handler work / scheduling | 8.8 | 16.1 | 14.3 | 16.8 | 13.2 |
| **Total** | **24.9** | **29.9** | **26.1** | **31.5** | **22.5** |

All durations are milliseconds from handler measurement entry through the operation result. Lambda INIT, including the completed SSM fetch, is excluded. The client is created lazily and retained for warm calls. Raw INIT and SSM measurements remain in samples.json.

Phase averages cover every invocation and add to the average handler total before rounding. Overlapping sockets are counted once. Without detailed probes, other handler work and scheduling is an elapsed remainder; its CPU, callback and internal code breakdown is not measured.

Mean confidence intervals use 10,000 percentile bootstrap resamples with a fixed seed, assuming independent observations within this run. SD is the sample standard deviation. These intervals do not measure variation between deployments or days. Write landing cohorts occur naturally and have unequal counts.

Package: 4,950,505 bytes ZIP; identical for every case. Detailed execution/source probes: disabled. DNS/socket/command timers remain enabled.

6 separate warm checks verified environment and client reuse without another SSM request, cluster DNS or topology discovery. These checks are excluded from the cold distributions.

![Measured connection breakdown](latency.png)

Each panel shows a real invocation nearest the handler median. Connections occupy separate overlapping lanes; do not add their elapsed times. INIT, provisioning, caller transport and post-result reporting are outside the overview. LocalStack timings do not predict AWS performance.
