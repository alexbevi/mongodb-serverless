/**
 * Runs the Lambda worker's handler in a fresh process, as a cold Lambda would.
 *
 * Usage: node benchmark/dist/cold.js '{"variant":"ssm","operation":"read"}' [warm]
 * Prints one result per invocation as JSON. With `warm`, the handler runs a second
 * time in the same process to check that the client and its sockets are reused.
 */
import { handler } from './lambda-worker.js';

// SAFETY: The handler asserts the variant and operation it receives.
const event = JSON.parse(process.argv[2] ?? '{}') as Parameters<typeof handler>[0];

const invocations = process.argv[3] === 'warm' ? 2 : 1;

const results = [];

for (let index = 0; index < invocations; index++) results.push(await handler(event));

process.stdout.write(JSON.stringify(results.map(result => ({
  ...result,
  lambda: { initMs: result.initialization?.processReadyMs ?? null, initSource: 'node-process-clock' }
}))));

// The worker retains its client for warm calls, so the process would otherwise stay open.
process.exit(0);
