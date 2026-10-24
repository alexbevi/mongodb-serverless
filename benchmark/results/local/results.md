# Local Docker results

Measured 2026-10-24T16:27:44.103Z · Node v24.18.0.

| Operation / pattern | n | Mean | Median | SD | p95 | Mean 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| read / Native MongoDB | 40 | 40.2 | 40.2 | 1.5 | 42.2 | 39.8–40.7 |
| read / No plugin | 40 | 33.0 | 32.9 | 1.4 | 35.3 | 32.5–33.4 |
| read / aws-ssm · cached topology | 40 | 32.9 | 32.2 | 1.6 | 35.5 | 32.4–33.3 |
| read / aws-ssm · no cached topology | 40 | 40.3 | 39.7 | 1.9 | 42.6 | 39.7–40.9 |
| write / Native MongoDB | 40 | 43.7 | 43.2 | 1.9 | 47.8 | 43.2–44.3 |
| write / No plugin | 40 | 50.3 | 55.2 | 9.4 | 60.1 | 47.4–53.1 |
| write / No plugin · 1 connection | 12 | 36.5 | 36.6 | 1.8 | 38.7 | 35.5–37.4 |
| write / No plugin · 2 connections | 28 | 56.3 | 55.9 | 2.3 | 60.2 | 55.5–57.1 |
| write / aws-ssm · cached topology | 40 | 34.7 | 34.4 | 1.7 | 37.4 | 34.2–35.2 |
| write / aws-ssm · no cached topology | 40 | 55.4 | 57.4 | 6.5 | 61.3 | 53.3–57.3 |

### Average read phase times

| Phase | Native MongoDB (n=40) | No plugin (n=40) | aws-ssm · cached topology (n=40) | aws-ssm · no cached topology (n=40) |
|---|---:|---:|---:|---:|
| Setup before the first member connection | 6.5 | 8.8 | 7.9 | 8.7 |
| ↳ Plugin topology read | — | — | ~0.1 | ~0.1 |
| ↳ URI and option parsing | ~2 | ~2 | ~1 | ~2 |
| ↳ SRV + TXT DNS | ~0.8 | ~0.4 | — | ~0.4 |
| ↳ Client and topology construction | ~2 | ~1 | ~2 | ~1 |
| ↳ No-monitoring module load | — | — | ~2 | — |
| ↳ Driver runtime metadata | ~2 | ~5 | ~3 | ~5 |
| SSM parameter request | 0.0 | 0.0 | 0.0 | 0.0 |
| SSM topology write | 0.0 | 0.0 | 0.0 | 2.1 |
| Monitor handshakes | 13.8 | 0.0 | 0.0 | 0.0 |
| Host DNS | 0.8 | 0.2 | 0.3 | 0.2 |
| TCP connect | 2.3 | 2.8 | 3.1 | 2.9 |
| TLS handshake | 3.3 | 3.8 | 4.0 | 4.0 |
| Initial hello | 3.2 | 4.3 | 4.3 | 4.3 |
| Authentication | 6.1 | 7.2 | 7.2 | 7.2 |
| Topology discovery (replSetGetStatus) | 0.0 | 0.0 | 0.0 | 3.8 |
| Topology parsing and member selection | 0.0 | 0.0 | 0.0 | 1.6 |
| Connection checkout wait | 0.0 | 0.1 | 0.1 | 0.1 |
| Command preparation | 0.3 | 1.6 | 1.5 | 1.2 |
| Operation command → reply | 3.6 | 3.9 | 4.1 | 3.9 |
| Reply → result returned | 0.4 | 0.3 | 0.3 | 0.2 |
| Other handler work | 0.0 | 0.0 | 0.0 | 0.0 |
| **Total** | **40.2** | **33.0** | **32.9** | **40.3** |

### Average write phase times

| Phase | Native MongoDB (n=40) | No plugin (n=40) | No plugin · 1 connection (n=12) | No plugin · 2 connections (n=28) | aws-ssm · cached topology (n=40) | aws-ssm · no cached topology (n=40) |
|---|---:|---:|---:|---:|---:|---:|
| Setup before the first member connection | 6.4 | 8.9 | 8.9 | 8.9 | 8.0 | 8.9 |
| ↳ Plugin topology read | — | — | — | — | ~0.1 | ~0.1 |
| ↳ URI and option parsing | ~2 | ~2 | ~2 | ~2 | ~1 | ~2 |
| ↳ SRV + TXT DNS | ~0.8 | ~0.4 | ~0.4 | ~0.4 | — | ~0.4 |
| ↳ Client and topology construction | ~2 | ~1 | ~1 | ~1 | ~2 | ~1 |
| ↳ No-monitoring module load | — | — | — | — | ~2 | — |
| ↳ Driver runtime metadata | ~2 | ~5 | ~5 | ~5 | ~3 | ~5 |
| SSM parameter request | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| SSM topology write | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 2.1 |
| Monitor handshakes | 14.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Host DNS | 0.5 | 0.4 | 0.3 | 0.5 | 0.3 | 0.5 |
| TCP connect | 2.5 | 4.9 | 3.1 | 5.6 | 2.7 | 5.1 |
| TLS handshake | 3.4 | 6.3 | 4.0 | 7.3 | 3.8 | 6.7 |
| Initial hello | 3.3 | 6.8 | 4.2 | 7.9 | 4.4 | 7.1 |
| Authentication | 6.0 | 9.9 | 7.0 | 11.2 | 7.0 | 10.4 |
| Topology discovery (replSetGetStatus) | 0.0 | 2.6 | 0.0 | 3.7 | 0.0 | 3.5 |
| Topology parsing and member selection | 0.0 | 1.7 | 0.0 | 2.5 | 0.0 | 2.6 |
| Connection checkout wait | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 |
| Command preparation | 0.2 | 1.7 | 1.4 | 1.9 | 1.4 | 1.7 |
| Operation command → reply | 7.0 | 6.8 | 7.3 | 6.6 | 6.9 | 6.6 |
| Reply → result returned | 0.3 | 0.1 | 0.2 | 0.1 | 0.2 | 0.1 |
| Other handler work | 0.1 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| **Total** | **43.7** | **50.3** | **36.5** | **56.3** | **34.7** | **55.4** |

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
