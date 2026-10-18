
| New pattern | vs previous main/serverless | vs previous native | Previous serverless median |
|---|---:|---:|---:|
| read / No plugin | +3.3% | +22.6% | 42.1 ms |
| read / SSM topology plugin | +11.8% | +29.4% | 42.1 ms |
| write / No plugin | +15.4% | +29.1% | 55.1 ms |
| write / SSM topology plugin | +30.1% | +41.4% | 55.1 ms |
| write / 1 connection | +23.3% | +35.7% | 55.1 ms |
| write / 2 connections | +12.8% | +26.9% | 55.1 ms |

Historical comparisons are descriptive: the previous main run used detailed profiling, watcher-provided topology, no timed SSM read, and secondary-only reads. Local results also used a different runtime/network harness. These percentages do not isolate the code change.

| Operation / pattern | n | Median | p95 | vs fresh main | vs fresh native |
|---|---:|---:|---:|---:|---:|
| read / Native MongoDB | 40 | 39.3 ms | 42.7 ms | -5.8% | +0.0% |
| read / Main (fresh SSM control) | 40 | 37.1 ms | 40.4 ms | +0.0% | +5.5% |
| read / No plugin | 40 | 40.7 ms | 43.6 ms | -9.6% | -3.5% |
| read / SSM topology plugin | 40 | 37.1 ms | 39.7 ms | +0.0% | +5.5% |
| write / Native MongoDB | 40 | 40.1 ms | 42.9 ms | -6.3% | +0.0% |
| write / Main (fresh SSM control) | 40 | 37.7 ms | 39.9 ms | +0.0% | +5.9% |
| write / No plugin | 40 | 46.7 ms | 51.2 ms | -23.8% | -16.5% |
| write / SSM topology plugin | 40 | 38.6 ms | 41.3 ms | -2.3% | +3.8% |
| No plugin / lucky write, 1 connection | 14 | 42.3 ms | 44.1 ms | -12.2% | -5.6% |
| No plugin / write, 2 connections | 26 | 48.1 ms | 52.3 ms | -27.6% | -20.1% |

Positive percentages mean lower median latency. Timings include SSM through the operation result; Lambda INIT and client close are separate. Write landing groups occur naturally and have unequal sample counts.
