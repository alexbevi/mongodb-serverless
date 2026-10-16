import { activities } from './activities.js';
import { executionRecorder } from './execution.js';

export async function measureAwsOperation<T>(operation: () => Promise<T>) {
  const recorder = executionRecorder();
  activities.start();
  const start = recorder.start();
  let result: T;

  try {
    result = await recorder.invoke(operation);
  } catch (error) {
    const execution = recorder.stop();
    activities.stop(execution.end);

    throw error;
  }

  const execution = recorder.stop();
  const spans = activities.stop(execution.end);

  return { result, start, end: execution.end, execution, activities: spans };
}
