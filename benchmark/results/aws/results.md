# AWS Lambda results

Measured 2026-10-20T01:44:39.965Z · Node v24.21.0.

| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 200 | 157.4 | 155.9 | 12.6 | 179.2 | 155.7–159.1 |
| read / No plugin | 200 | 128.8 | 128.2 | 13.5 | 149.3 | 127.0–130.7 |
| read / aws-ssm · cached topology | 200 | 119.5 | 120.4 | 10.8 | 137.3 | 118.0–121.0 |
| read / aws-ssm · no cached topology | 200 | 171.4 | 170.2 | 13.7 | 191.7 | 169.5–173.3 |
| write / Native MongoDB | 200 | 166.5 | 161.6 | 28.0 | 194.0 | 163.1–170.7 |
| write / No plugin | 200 | 178.1 | 186.1 | 41.0 | 228.1 | 172.4–183.9 |
| write / aws-ssm · cached topology | 200 | 125.5 | 123.7 | 20.2 | 148.7 | 123.0–128.5 |
| write / aws-ssm · no cached topology | 200 | 213.4 | 221.5 | 32.8 | 251.7 | 208.9–217.9 |
| No plugin / lucky write, 1 connection | 67 | 131.0 | 130.5 | 13.4 | 149.7 | 127.9–134.4 |
| No plugin / write, 2 connections | 133 | 201.8 | 197.6 | 27.3 | 247.5 | 197.5–206.6 |

### Average read phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 5.1 | 5.4 | 0.0 | 4.9 |
| Monitor handshakes · overlapping time counted once | 64.9 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 5.1 | 4.0 | 5.1 | 4.4 |
| TCP connection | 3.4 | 1.5 | 1.6 | 1.5 |
| TLS handshake | 38.4 | 39.8 | 38.7 | 39.9 |
| Initial hello | 3.1 | 8.3 | 7.9 | 8.0 |
| Authentication | 10.3 | 12.0 | 11.5 | 12.2 |
| Topology discovery | 0.0 | 0.0 | 0.0 | 4.8 |
| Topology storage · SSM PutParameter | 0.0 | 0.0 | 0.0 | 35.5 |
| Additional hello commands | 0.0 | 0.0 | 0.0 | 0.0 |
| Prepare/send operation | 0.9 | 1.0 | 1.1 | 0.5 |
| Operation request → reply | 3.6 | 3.3 | 3.3 | 2.5 |
| Other handler work / scheduling | 22.6 | 53.5 | 50.3 | 57.2 |
| **Total** | **157.4** | **128.8** | **119.5** | **171.4** |

### Average write phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | No plugin · lucky (n=67) | No plugin · 2 connections (n=133) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 4.8 | 4.9 | 5.1 | 4.8 | 0.0 | 4.9 |
| Monitor handshakes · overlapping time counted once | 69.2 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 3.7 | 7.9 | 5.1 | 9.2 | 4.7 | 6.5 |
| TCP connection | 2.4 | 2.4 | 1.6 | 2.7 | 1.4 | 2.4 |
| TLS handshake | 41.9 | 67.8 | 39.6 | 82.0 | 42.0 | 67.0 |
| Initial hello | 3.7 | 10.7 | 8.3 | 11.9 | 7.9 | 10.0 |
| Authentication | 10.6 | 13.8 | 11.8 | 14.8 | 11.7 | 14.1 |
| Topology discovery | 0.0 | 3.3 | 0.0 | 5.0 | 0.0 | 5.0 |
| Topology storage · SSM PutParameter | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 35.3 |
| Additional hello commands | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Prepare/send operation | 0.9 | 0.7 | 1.1 | 0.5 | 1.1 | 0.5 |
| Operation request → reply | 7.2 | 6.8 | 7.1 | 6.7 | 7.7 | 6.3 |
| Other handler work / scheduling | 22.1 | 59.9 | 51.2 | 64.2 | 49.0 | 61.4 |
| **Total** | **166.5** | **178.1** | **131.0** | **201.8** | **125.5** | **213.4** |

All durations are milliseconds from handler measurement entry through the operation result. Lambda INIT, including the completed SSM fetch, is excluded. The client is created lazily and retained for warm calls. Raw INIT and SSM measurements remain in samples.json.

Phase averages cover every invocation and add to the average handler total before rounding. Overlapping sockets are counted once. Without detailed probes, other handler work and scheduling is an elapsed remainder; its CPU, callback and internal code breakdown is not measured.

Mean confidence intervals use 10,000 percentile bootstrap resamples with a fixed seed, assuming independent observations within this run. SD is the sample standard deviation. These intervals do not measure variation between deployments or days. Write landing cohorts occur naturally and have unequal counts.

Package: 4,951,306 bytes ZIP; identical for every case. Detailed execution/source probes: disabled. DNS/socket/command timers remain enabled.

8 separate warm checks verified environment and client reuse without another SSM request, cluster DNS or topology discovery. These checks are excluded from the cold distributions.

![Measured connection breakdown](latency.png)

Each panel shows a real invocation nearest the handler median. Connections occupy separate overlapping lanes; do not add their elapsed times. INIT, provisioning, caller transport and post-result reporting are outside the overview. LocalStack timings do not predict AWS performance.
