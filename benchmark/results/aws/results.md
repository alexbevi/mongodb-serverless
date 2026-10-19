# AWS Lambda results

Measured 2026-10-19T19:07:29.870Z · Node v24.21.0.

| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 200 | 154.6 | 154.1 | 13.1 | 177.6 | 152.8–156.5 |
| read / No plugin | 200 | 139.4 | 137.9 | 15.1 | 162.2 | 137.4–141.5 |
| read / aws-ssm · cached topology | 200 | 119.5 | 118.8 | 11.8 | 137.6 | 117.9–121.1 |
| write / Native MongoDB | 200 | 167.7 | 164.8 | 26.5 | 186.7 | 164.3–171.6 |
| write / No plugin | 200 | 180.8 | 188.1 | 32.7 | 223.5 | 176.3–185.2 |
| write / aws-ssm · cached topology | 200 | 122.5 | 122.3 | 11.1 | 139.8 | 120.9–124.0 |
| No plugin / lucky write, 1 connection | 71 | 142.4 | 143.3 | 12.6 | 162.5 | 139.5–145.3 |
| No plugin / write, 2 connections | 129 | 201.9 | 201.5 | 17.5 | 232.0 | 198.9–205.0 |

### Average read phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | aws-ssm · cached topology (n=200) |
|---|---:|---:|---:|
| Cluster DNS · SRV + TXT | 4.9 | 5.0 | 0.0 |
| Monitor handshakes · overlapping time counted once | 64.0 | 0.0 | 0.0 |
| Application host DNS | 4.6 | 4.3 | 4.8 |
| TCP connection | 3.4 | 1.3 | 1.4 |
| TLS handshake | 38.0 | 40.4 | 38.8 |
| Initial hello | 3.0 | 7.7 | 8.1 |
| Authentication | 10.2 | 11.8 | 11.4 |
| Topology discovery | 0.0 | 3.5 | 0.0 |
| Additional hello commands | 0.0 | 4.5 | 0.0 |
| Prepare/send operation | 0.9 | 0.4 | 1.1 |
| Operation request → reply | 3.5 | 3.0 | 3.3 |
| Other handler work / scheduling | 22.0 | 57.6 | 50.6 |
| **Total** | **154.6** | **139.4** | **119.5** |

### Average write phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | No plugin · lucky (n=71) | No plugin · 2 connections (n=129) | aws-ssm · cached topology (n=200) |
|---|---:|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 5.0 | 4.9 | 4.8 | 5.0 | 0.0 |
| Monitor handshakes · overlapping time counted once | 69.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 4.7 | 7.6 | 4.0 | 9.7 | 4.9 |
| TCP connection | 2.5 | 2.3 | 1.4 | 2.8 | 1.3 |
| TLS handshake | 41.6 | 64.7 | 40.2 | 78.2 | 39.9 |
| Initial hello | 3.6 | 10.1 | 7.7 | 11.4 | 7.7 |
| Authentication | 11.0 | 13.3 | 11.4 | 14.4 | 11.5 |
| Topology discovery | 0.0 | 3.7 | 3.7 | 3.8 | 0.0 |
| Additional hello commands | 0.0 | 4.8 | 4.6 | 4.9 | 0.0 |
| Prepare/send operation | 0.9 | 0.5 | 0.5 | 0.5 | 1.1 |
| Operation request → reply | 6.7 | 6.4 | 6.7 | 6.3 | 7.0 |
| Other handler work / scheduling | 22.7 | 62.4 | 57.5 | 65.2 | 49.0 |
| **Total** | **167.7** | **180.8** | **142.4** | **201.9** | **122.5** |

All durations are milliseconds from handler measurement entry through the operation result. Lambda INIT, including the completed SSM fetch, is excluded. The client is created lazily and retained for warm calls. Raw INIT and SSM measurements remain in samples.json.

Phase averages cover every invocation and add to the average handler total before rounding. Overlapping sockets are counted once. Without detailed probes, other handler work and scheduling is an elapsed remainder; its CPU, callback and internal code breakdown is not measured.

Mean confidence intervals use 10,000 percentile bootstrap resamples with a fixed seed, assuming independent observations within this run. SD is the sample standard deviation. These intervals do not measure variation between deployments or days. Write landing cohorts occur naturally and have unequal counts.

Package: 4,950,505 bytes ZIP; identical for every case. Detailed execution/source probes: disabled. DNS/socket/command timers remain enabled.

6 separate warm checks verified environment and client reuse without another SSM request, cluster DNS or topology discovery. These checks are excluded from the cold distributions.

![Measured connection breakdown](latency.png)

Each panel shows a real invocation nearest the handler median. Connections occupy separate overlapping lanes; do not add their elapsed times. INIT, provisioning, caller transport and post-result reporting are outside the overview. LocalStack timings do not predict AWS performance.
