# AWS Lambda results

Measured 2026-10-20T03:36:10.555Z · Node v24.21.0.

| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 200 | 160.4 | 158.1 | 15.1 | 184.3 | 158.4–162.6 |
| read / No plugin | 200 | 116.2 | 114.2 | 12.4 | 131.2 | 114.6–118.1 |
| read / aws-ssm · cached topology | 200 | 114.3 | 112.9 | 10.7 | 130.7 | 112.8–115.8 |
| read / aws-ssm · no cached topology | 200 | 161.2 | 159.6 | 13.5 | 183.2 | 159.3–163.1 |
| write / Native MongoDB | 200 | 171.0 | 168.9 | 24.7 | 208.1 | 167.8–174.7 |
| write / No plugin | 200 | 162.1 | 171.4 | 35.1 | 210.5 | 157.2–167.0 |
| write / aws-ssm · cached topology | 200 | 119.8 | 116.7 | 12.0 | 142.1 | 118.2–121.5 |
| write / aws-ssm · no cached topology | 200 | 204.2 | 214.3 | 35.8 | 241.3 | 199.4–209.3 |
| No plugin / lucky write, 1 connection | 73 | 121.5 | 119.4 | 14.9 | 133.6 | 118.4–125.1 |
| No plugin / write, 2 connections | 127 | 185.5 | 183.1 | 17.7 | 213.3 | 182.5–188.6 |

### Average read phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 5.0 | 2.3 | 0.0 | 2.2 |
| Monitor handshakes · overlapping time counted once | 65.1 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 5.8 | 6.0 | 4.7 | 5.1 |
| TCP connection | 3.8 | 1.5 | 1.5 | 1.5 |
| TLS handshake | 38.6 | 39.3 | 38.8 | 39.4 |
| Initial hello | 3.3 | 7.8 | 7.9 | 8.3 |
| Authentication | 11.1 | 12.0 | 11.3 | 11.9 |
| Topology discovery | 0.0 | 0.0 | 0.0 | 5.0 |
| Topology storage · SSM PutParameter | 0.0 | 0.0 | 0.0 | 35.7 |
| Additional hello commands | 0.0 | 0.0 | 0.0 | 0.0 |
| Prepare/send operation | 1.0 | 1.1 | 1.1 | 0.6 |
| Operation request → reply | 3.4 | 3.3 | 3.1 | 2.5 |
| Other handler work / scheduling | 23.3 | 43.0 | 45.9 | 49.0 |
| **Total** | **160.4** | **116.2** | **114.3** | **161.2** |

### Average write phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | No plugin · lucky (n=73) | No plugin · 2 connections (n=127) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|---:|---:|
| Cluster DNS · SRV + TXT | 4.8 | 2.2 | 2.3 | 2.2 | 0.0 | 2.2 |
| Monitor handshakes · overlapping time counted once | 70.8 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Application host DNS | 3.8 | 8.0 | 6.0 | 9.1 | 4.5 | 7.0 |
| TCP connection | 2.9 | 2.3 | 1.4 | 2.8 | 1.3 | 2.5 |
| TLS handshake | 42.2 | 64.8 | 40.5 | 78.8 | 40.5 | 66.6 |
| Initial hello | 3.7 | 10.4 | 8.4 | 11.5 | 8.0 | 11.0 |
| Authentication | 11.5 | 14.3 | 11.8 | 15.7 | 11.2 | 14.3 |
| Topology discovery | 0.0 | 2.8 | 0.0 | 4.5 | 0.0 | 4.8 |
| Topology storage · SSM PutParameter | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 36.0 |
| Additional hello commands | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Prepare/send operation | 1.0 | 0.7 | 1.1 | 0.5 | 1.1 | 0.6 |
| Operation request → reply | 7.3 | 7.0 | 7.4 | 6.7 | 7.7 | 6.5 |
| Other handler work / scheduling | 22.9 | 49.6 | 42.5 | 53.7 | 45.5 | 52.7 |
| **Total** | **171.0** | **162.1** | **121.5** | **185.5** | **119.8** | **204.2** |

All durations are milliseconds from handler measurement entry through the operation result. Lambda INIT, including the completed SSM fetch, is excluded. The client is created lazily and retained for warm calls. Raw INIT and SSM measurements remain in samples.json.

Phase averages cover every invocation and add to the average handler total before rounding. Overlapping sockets are counted once. Without detailed probes, other handler work and scheduling is an elapsed remainder; its CPU, callback and internal code breakdown is not measured.

Mean confidence intervals use 10,000 percentile bootstrap resamples with a fixed seed, assuming independent observations within this run. SD is the sample standard deviation. These intervals do not measure variation between deployments or days. Write landing cohorts occur naturally and have unequal counts.

Package: 4,950,399 bytes ZIP; identical for every case. Detailed execution/source probes: disabled. DNS/socket/command timers remain enabled.

8 separate warm checks verified environment and client reuse without another SSM request, cluster DNS or topology discovery. These checks are excluded from the cold distributions.

![Measured connection breakdown](latency.png)

Each panel shows a real invocation nearest the handler median. Connections occupy separate overlapping lanes; do not add their elapsed times. INIT, provisioning, caller transport and post-result reporting are outside the overview. LocalStack timings do not predict AWS performance.
