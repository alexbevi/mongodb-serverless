# LocalStack 4.14.0 results

Measured 2026-10-20T01:43:51.955Z · Node v24.21.0.

| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 200 | 36.4 | 36.2 | 1.6 | 39.0 | 36.2–36.6 |
| read / No plugin | 200 | 35.2 | 35.0 | 1.5 | 37.3 | 35.0–35.4 |
| read / aws-ssm · cached topology | 200 | 33.3 | 33.0 | 1.4 | 35.5 | 33.1–33.5 |
| read / aws-ssm · no cached topology | 200 | 41.7 | 41.4 | 1.6 | 44.3 | 41.5–41.9 |
| write / Native MongoDB | 200 | 37.1 | 36.9 | 1.6 | 39.3 | 36.9–37.3 |
| write / No plugin | 200 | 43.2 | 45.5 | 5.2 | 49.2 | 42.5–43.9 |
| write / aws-ssm · cached topology | 200 | 34.2 | 33.9 | 1.3 | 36.5 | 34.0–34.3 |
| write / aws-ssm · no cached topology | 200 | 47.6 | 49.2 | 4.3 | 53.6 | 47.1–48.2 |
| No plugin / lucky write, 1 connection | 66 | 36.2 | 35.8 | 1.8 | 38.5 | 35.8–36.6 |
| No plugin / write, 2 connections | 134 | 46.7 | 46.4 | 1.8 | 50.2 | 46.4–47.0 |

### Average read phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 0.4 | 2.0 | 0.0 | 2.0 |
| Monitor handshakes · overlapping time counted once | 12.1 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 1.3 | 0.4 | 0.4 | 0.4 |
| TCP connection | 0.3 | 0.3 | 0.3 | 0.3 |
| TLS handshake | 1.5 | 2.4 | 2.4 | 2.4 |
| Initial hello | 1.0 | 3.2 | 3.3 | 3.2 |
| Authentication | 5.2 | 5.0 | 5.0 | 5.0 |
| Topology discovery | 0.0 | 0.0 | 0.0 | 1.4 |
| Topology storage · SSM PutParameter | 0.0 | 0.0 | 0.0 | 3.6 |
| Additional hello commands | 0.0 | 0.0 | 0.0 | 0.0 |
| Prepare/send operation | 0.4 | 0.4 | 0.4 | 0.2 |
| Operation request → reply | 0.6 | 0.7 | 0.7 | 0.6 |
| Other handler work / scheduling | 13.5 | 20.8 | 20.8 | 22.6 |
| **Total** | **36.4** | **35.2** | **33.3** | **41.7** |

### Average write phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | No plugin · lucky (n=66) | No plugin · 2 connections (n=134) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 0.4 | 2.0 | 2.0 | 2.0 | 0.0 | 2.0 |
| Monitor handshakes · overlapping time counted once | 12.6 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 1.0 | 0.6 | 0.4 | 0.7 | 0.4 | 0.6 |
| TCP connection | 0.3 | 0.5 | 0.3 | 0.6 | 0.3 | 0.5 |
| TLS handshake | 1.5 | 3.5 | 2.4 | 4.0 | 2.4 | 3.4 |
| Initial hello | 1.0 | 3.8 | 3.2 | 4.1 | 3.3 | 3.8 |
| Authentication | 5.2 | 5.9 | 5.1 | 6.3 | 5.0 | 5.9 |
| Topology discovery | 0.0 | 1.0 | 0.0 | 1.5 | 0.0 | 1.4 |
| Topology storage · SSM PutParameter | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 3.6 |
| Additional hello commands | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Prepare/send operation | 0.4 | 0.3 | 0.4 | 0.2 | 0.4 | 0.2 |
| Operation request → reply | 1.9 | 1.9 | 2.0 | 1.9 | 2.1 | 1.9 |
| Other handler work / scheduling | 12.8 | 23.8 | 20.4 | 25.4 | 20.2 | 24.4 |
| **Total** | **37.1** | **43.2** | **36.2** | **46.7** | **34.2** | **47.6** |

All durations are milliseconds from handler measurement entry through the operation result. Lambda INIT, including the completed SSM fetch, is excluded. The client is created lazily and retained for warm calls. Raw INIT and SSM measurements remain in samples.json.

Phase averages cover every invocation and add to the average handler total before rounding. Overlapping sockets are counted once. Without detailed probes, other handler work and scheduling is an elapsed remainder; its CPU, callback and internal code breakdown is not measured.

Mean confidence intervals use 10,000 percentile bootstrap resamples with a fixed seed, assuming independent observations within this run. SD is the sample standard deviation. These intervals do not measure variation between deployments or days. Write landing cohorts occur naturally and have unequal counts.

Package: 4,951,304 bytes ZIP; identical for every case. Detailed execution/source probes: disabled. DNS/socket/command timers remain enabled.

8 separate warm checks verified environment and client reuse without another SSM request, cluster DNS or topology discovery. These checks are excluded from the cold distributions.

![Measured connection breakdown](latency.png)

Each panel shows a real invocation nearest the handler median. Connections occupy separate overlapping lanes; do not add their elapsed times. INIT, provisioning, caller transport and post-result reporting are outside the overview. LocalStack timings do not predict AWS performance.
