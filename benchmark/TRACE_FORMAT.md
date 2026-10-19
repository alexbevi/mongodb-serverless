# Diagnostic trace encoding

The Lambda samples retain every recorded timing value. To keep the JSON small,
repeated execution stacks live in `executionSources`, and callback/activity
records use the column names in the top-level `diagnosticEncoding` object.

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
