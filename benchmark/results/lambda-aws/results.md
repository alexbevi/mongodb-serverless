# AWS Lambda results

100 cold invocations per driver/operation case.

| New pattern | vs previous main/serverless | vs previous native | Previous serverless median |
|---|---:|---:|---:|
| read / No plugin | -6.4% | +13.5% | 212.4 ms |
| read / SSM topology plugin | +2.1% | +20.4% | 212.4 ms |
| write / No plugin | -30.8% | +3.4% | 210.5 ms |
| write / SSM topology plugin | +0.7% | +26.7% | 210.5 ms |
| write / 1 connection | -8.0% | +20.3% | 210.5 ms |
| write / 2 connections | -37.1% | -1.3% | 210.5 ms |

Historical comparisons are descriptive: the previous main run used detailed profiling, watcher-provided topology, no timed SSM read, and secondary-only reads. Local results also used a different runtime/network harness. These percentages do not isolate the code change.

| Operation / pattern | n | Median | p95 | vs fresh main | vs fresh native |
|---|---:|---:|---:|---:|---:|
| read / Native MongoDB | 100 | 248.3 ms | 285.4 ms | -22.1% | +0.0% |
| read / Main (fresh SSM control) | 100 | 203.3 ms | 233.8 ms | +0.0% | +18.1% |
| read / No plugin | 100 | 226.0 ms | 265.8 ms | -11.2% | +9.0% |
| read / SSM topology plugin | 100 | 208.0 ms | 252.1 ms | -2.3% | +16.2% |
| write / Native MongoDB | 100 | 249.5 ms | 293.0 ms | -21.0% | +0.0% |
| write / Main (fresh SSM control) | 100 | 206.3 ms | 242.4 ms | +0.0% | +17.3% |
| write / No plugin | 100 | 275.2 ms | 329.7 ms | -33.4% | -10.3% |
| write / SSM topology plugin | 100 | 209.1 ms | 254.9 ms | -1.4% | +16.2% |
| No plugin / lucky write, 1 connection | 28 | 227.3 ms | 271.4 ms | -10.2% | +8.9% |
| No plugin / write, 2 connections | 72 | 288.6 ms | 330.7 ms | -39.9% | -15.7% |

| Pattern | Median INIT | Median INIT + handler |
|---|---:|---:|
| read / No plugin | 518.7 ms | 738.0 ms |
| read / SSM topology plugin | 533.7 ms | 737.1 ms |
| write / No plugin | 516.3 ms | 792.4 ms |
| write / SSM topology plugin | 521.4 ms | 730.2 ms |

INIT + handler excludes Lambda provisioning, invocation transport, and close. All variants load the same benchmark package.

Lucky-write median reduction versus two-connection writes: **21.2%**. These are observed landing groups, not paired trials.

Positive percentages mean lower median latency. Timings include SSM through the operation result; Lambda INIT and client close are separate. Write landing groups occur naturally and have unequal sample counts.
