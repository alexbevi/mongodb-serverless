# AWS Lambda results

Measured 2026-10-25T15:50:29.318Z · Node v24.21.0.

| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 200 | 158.5 | 157.0 | 14.4 | 179.8 | 156.5–160.5 |
| read / No plugin | 200 | 117.8 | 116.8 | 11.6 | 135.0 | 116.3–119.5 |
| read / aws-ssm · cached topology | 200 | 117.8 | 117.7 | 10.8 | 135.2 | 116.4–119.3 |
| read / aws-ssm · no cached topology | 200 | 161.3 | 160.7 | 12.5 | 183.6 | 159.6–163.0 |
| write / Native MongoDB | 200 | 169.0 | 164.9 | 32.7 | 201.1 | 165.1–174.1 |
| write / No plugin | 200 | 170.0 | 176.3 | 48.7 | 212.5 | 163.9–177.4 |
| write / No plugin · 1 connection | 61 | 129.5 | 118.3 | 66.8 | 142.2 | 118.7–148.2 |
| write / No plugin · 2 connections | 139 | 187.8 | 185.8 | 21.0 | 213.7 | 184.6–191.4 |
| write / aws-ssm · cached topology | 200 | 121.7 | 120.8 | 16.8 | 142.1 | 119.5–124.3 |
| write / aws-ssm · no cached topology | 200 | 206.1 | 214.0 | 32.5 | 242.3 | 201.6–210.4 |

### Average read phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|
| Setup before the first member connection | 22.7 | 35.3 | 37.3 | 35.9 |
| ↳ Plugin topology read | — | — | ~0.2 | ~0.4 |
| ↳ URI and option parsing | ~6 | ~7 | ~7 | ~8 |
| ↳ SRV + TXT DNS | ~3 | ~2 | — | ~2 |
| ↳ Client and topology construction | ~8 | ~5 | ~9 | ~6 |
| ↳ No-monitoring module load | — | — | ~9 | — |
| ↳ Driver runtime metadata | ~6 | ~21 | ~13 | ~21 |
| SSM parameter request | 0.0 | 0.0 | 0.0 | 0.0 |
| SSM topology write | 0.0 | 0.0 | 0.0 | 35.2 |
| Monitor handshakes | 64.1 | 0.0 | 0.0 | 0.0 |
| Host DNS | 5.7 | 5.9 | 5.1 | 6.0 |
| TCP connect | 4.2 | 1.3 | 1.2 | 1.2 |
| TLS handshake | 38.4 | 39.9 | 39.4 | 39.9 |
| Initial hello | 5.1 | 8.2 | 7.9 | 7.9 |
| Authentication | 11.6 | 15.9 | 15.3 | 16.0 |
| Topology discovery (replSetGetStatus) | 0.0 | 0.0 | 0.0 | 4.3 |
| Topology parsing and member selection | 0.0 | 0.0 | 0.0 | 6.0 |
| Connection checkout wait | 0.2 | 0.4 | 0.4 | 0.5 |
| Command preparation | 0.9 | 5.8 | 5.8 | 4.4 |
| Operation command → reply | 4.1 | 3.8 | 3.9 | 2.8 |
| Reply → result returned | 1.5 | 1.3 | 1.4 | 1.1 |
| Other handler work | 0.0 | 0.0 | 0.0 | 0.0 |
| **Total** | **158.5** | **117.8** | **117.8** | **161.3** |

### Average write phase times

| Phase | Native MongoDB (n=200) | No plugin (n=200) | No plugin · 1 connection (n=61) | No plugin · 2 connections (n=139) | aws-ssm · cached topology (n=200) | aws-ssm · no cached topology (n=200) |
|---|---:|---:|---:|---:|---:|---:|
| Setup before the first member connection | 21.3 | 34.7 | 34.3 | 34.9 | 36.4 | 36.1 |
| ↳ Plugin topology read | — | — | — | — | ~0.2 | ~0.4 |
| ↳ URI and option parsing | ~5 | ~7 | ~7 | ~7 | ~7 | ~8 |
| ↳ SRV + TXT DNS | ~3 | ~2 | ~2 | ~2 | — | ~2 |
| ↳ Client and topology construction | ~7 | ~5 | ~5 | ~5 | ~9 | ~6 |
| ↳ No-monitoring module load | — | — | — | — | ~8 | — |
| ↳ Driver runtime metadata | ~6 | ~20 | ~20 | ~20 | ~13 | ~21 |
| SSM parameter request | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| SSM topology write | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 34.6 |
| Monitor handshakes | 69.1 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Host DNS | 4.4 | 8.6 | 6.1 | 9.7 | 5.0 | 7.8 |
| TCP connect | 2.3 | 2.1 | 1.6 | 2.3 | 1.3 | 2.1 |
| TLS handshake | 41.4 | 70.4 | 47.0 | 80.7 | 40.7 | 68.4 |
| Initial hello | 5.7 | 10.7 | 8.3 | 11.7 | 8.1 | 10.2 |
| Authentication | 12.1 | 19.4 | 16.4 | 20.6 | 15.5 | 19.5 |
| Topology discovery (replSetGetStatus) | 0.0 | 2.8 | 0.0 | 4.0 | 0.0 | 4.2 |
| Topology parsing and member selection | 0.0 | 6.6 | 0.0 | 9.5 | 0.0 | 9.4 |
| Connection checkout wait | 1.2 | 0.5 | 0.4 | 0.5 | 0.4 | 0.5 |
| Command preparation | 0.9 | 6.1 | 5.0 | 6.6 | 5.1 | 5.9 |
| Operation command → reply | 8.2 | 7.7 | 9.6 | 6.8 | 8.5 | 6.8 |
| Reply → result returned | 0.9 | 0.5 | 0.8 | 0.4 | 0.8 | 0.4 |
| Other handler work | 1.4 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| **Total** | **169.0** | **170.0** | **129.5** | **187.8** | **121.7** | **206.1** |

Durations are milliseconds from handler entry to the operation result. SSM retrieval during startup is excluded.

Every phase comes from driver events (`commandStarted`, `connectionReady`, `serverHeartbeat*`, `topologyOpening`, checkout events) and socket events (`lookup`, `connect`, `secureConnect`, first reply). Nothing in the driver is patched. Each millisecond is counted once, in the order the table lists phases; overlapping sockets are not added.

Setup has no events inside it. The ↳ rows marked ~ split the measured setup in proportions from an earlier run with code probes; SRV + TXT DNS applies only where the pattern resolves the SRV record.

Confidence intervals use 10,000 bootstrap resamples with a fixed seed and describe this run only.

8 warm checks verified client and socket reuse without another SSM request or discovery. They are excluded from the cold results.

### Read connection breakdowns

#### Native MongoDB

![Read · Native MongoDB](read-native.png)

#### No plugin

![Read · No plugin](read-no-plugin.png)

#### aws-ssm · cached topology

![Read · aws-ssm · cached topology](read-ssm.png)

#### aws-ssm · no cached topology

![Read · aws-ssm · no cached topology](read-ssm-uncached.png)


### Write connection breakdowns

#### Native MongoDB

![Write · Native MongoDB](write-native.png)

#### No plugin · 1 connection

![Write · No plugin · 1 connection](write-no-plugin-1-connection.png)

#### No plugin · 2 connections

![Write · No plugin · 2 connections](write-no-plugin-2-connections.png)

#### aws-ssm · cached topology

![Write · aws-ssm · cached topology](write-ssm.png)

#### aws-ssm · no cached topology

![Write · aws-ssm · no cached topology](write-ssm-uncached.png)

Each chart shows the sample nearest its cohort median. Sockets occupy separate overlapping rows; do not add their times.
