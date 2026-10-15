import subprocess
import unittest
from pathlib import Path


class AwsBuildTest(unittest.TestCase):
    def test_worker_overlay_measures_operation_and_rejects_changed_source(self):
        module = (Path(__file__).parents[1] / 'build-aws-diagnostics.mjs').as_uri()
        source = '''
import { instrument } from "./instrument.mjs";
const handler = createOperationHandler(event.operation as 'read' | 'write',
    () => createBenchmarkClient(event.mode, uri, options, on));
  const start = performance.now();
  try {
    const result = await handler();
    const end = performance.now();
    return { trace: { start, end, dns: telemetry.dns } };
  }
'''
        import json
        script = f'''
import assert from 'node:assert/strict';
import {{ instrumentWorker }} from {json.dumps(module)};
const source = {json.dumps(source)};
const output = instrumentWorker(source, '/benchmark');
assert.ok(output.includes('await measureAwsOperation(handler)'));
assert.ok(output.includes('execution, activities: spans, dns:'));
assert.ok(output.includes('activities.sync("Facade / client construction"'));
assert.ok(output.includes('/benchmark/instrument.ts'));
assert.throws(() => instrumentWorker(source.replace('await handler()', 'await otherHandler()'), '/benchmark'), /Re-verify AWS worker/);
'''
        result = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
