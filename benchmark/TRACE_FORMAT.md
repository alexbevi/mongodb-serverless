# Diagnostic trace encoding

The Lambda samples retain every recorded timing value. To keep the JSON small,
repeated execution stacks live in `executionSources`, and callback/activity
records use the column names in the top-level `diagnosticEncoding` object.

`sample.totalMs` and `trace` cover the handler measurement through the operation
result. `initialization.ssm` holds the SSM request completed before handler entry;
`trace.ssm` contains only requests made during that invocation. INIT already
includes its SSM request, so do not add `ssmMs` to INIT or subtract it from the
handler duration when `ssmPhase` is `init`.

`lambda.initSource` identifies the startup clock: `lambda-report` uses AWS's INIT
duration; `node-process-clock` uses Node's performance clock through completed
module initialization where LocalStack omits INIT. Neither measures container
provisioning. `configuration.warmVerification` records separate warm checks;
these are excluded from the cold cohorts.

In `summary.json`, each illustrated trace's `totalMs` is INIT plus handler time.
Its `segments` use handler-relative times; `initMs` and `handlerMs` retain both
boundaries. `accountingMs.init` is INIT excluding SSM, and `accountingMs.ssm`
contains SSM time, so the accounting values sum to the illustrated cold total.

Each encoded row begins with a presence mask. Bit 0 corresponds to the first
column, bit 1 to the second, and so on. The remaining entries are the values for
present columns, in column order. This preserves missing fields separately from
explicit null values. Timestamps and CPU measurements are not rounded.

The report expands these rows automatically before calculating or rendering
anything. To expand a file for manual inspection, run from the repository root:

```sh
python3 - <<'PY'
import json
from pathlib import Path
from benchmark.compact import expand_diagnostics

source = Path('benchmark/results/aws/samples.json')
data = json.loads(source.read_text())
expand_diagnostics(data)
Path('/tmp/mongodb-expanded.json').write_text(json.dumps(data, indent=2))
PY
```

The expanded file retains `sourceId` references into `executionSources`.

Protocol-only Lambda samples omit `trace.execution` and `trace.activities`.
They retain DNS, socket and command intervals. The report assigns elapsed time
outside those intervals to `other`: handler work and scheduling whose internal
cause was not measured. It does not infer CPU or callback durations. Parallel
socket intervals still use the same non-overlapping accounting priority.
