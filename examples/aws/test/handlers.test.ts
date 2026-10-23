import { expect, it, vi } from 'vitest';
import {
  createFindHandler, createSaveHandler, type ExampleCollection, type OperationRunner
} from '../src/handlers.js';

function event(body?: string) {
  return {
    body: body ?? null, headers: {}, httpMethod: body === undefined ? 'GET' : 'POST',
    isBase64Encoded: false, multiValueHeaders: {}, multiValueQueryStringParameters: null,
    path: '/', pathParameters: null, queryStringParameters: { id: 'example' },
    requestContext: {}, resource: '/', stageVariables: null
  };
}

function context() {
  return {
    callbackWaitsForEmptyEventLoop: true, functionName: 'example', functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:example', memoryLimitInMB: '1769', awsRequestId: 'request',
    logGroupName: 'group', logStreamName: 'stream', getRemainingTimeInMillis: () => 10_000,
    done: () => {}, fail: () => {}, succeed: () => {}
  };
}

function runner(collection: ExampleCollection, connectMs = 50, operationMs = 10, ssmMs = 25): OperationRunner {
  return async operation => ({ result: await operation(collection), ssmMs, connectMs, operationMs });
}

function responseBody(response: void | { statusCode: number; body: string }) {
  if (response === undefined) throw new Error('Handler returned no response');

  const body: {
    document?: object;
    id?: string;
    timing: { coldStart: boolean; ssmMs: number; connectMs: number; operationMs: number };
  } = JSON.parse(response.body);

  return { response, body };
}

it('finds by id on any healthy member and reports warm reuse', async () => {
  const findOne = vi.fn(async () => ({ _id: 'example', value: 'hello' }));
  const handler = createFindHandler(runner({ findOne, updateOne: vi.fn() }));
  const runtime = context();

  const first = responseBody(await handler(event(), runtime));
  const second = responseBody(await handler(event(), runtime));

  expect(first.response.statusCode).toBe(200);
  expect(first.body).toMatchObject({
    document: { _id: 'example', value: 'hello' },
    timing: { coldStart: true, ssmMs: 25, connectMs: 50, operationMs: 10 }
  });
  expect(second.body.timing).toEqual({ coldStart: false, ssmMs: 0, connectMs: 50, operationMs: 10 });
  expect(runtime.callbackWaitsForEmptyEventLoop).toBe(false);
  expect(findOne).toHaveBeenCalledWith({ _id: 'example' }, { readPreference: 'nearest' });
});

it('upserts a validated document', async () => {
  const updateOne = vi.fn(async () => ({ acknowledged: true, matchedCount: 0, upsertedCount: 1 }));
  const handler = createSaveHandler(runner({ findOne: vi.fn(), updateOne }));
  const runtime = context();
  const result = responseBody(await handler(event('{"id":"saved","value":"hello"}'), runtime));

  expect(result.response.statusCode).toBe(200);
  expect(result.body).toMatchObject({
    id: 'saved', timing: { coldStart: true, ssmMs: 25, connectMs: 50, operationMs: 10 }
  });
  expect(updateOne).toHaveBeenCalledWith(
    { _id: 'saved' },
    { $set: { value: 'hello' }, $currentDate: { updatedAt: true } },
    { upsert: true }
  );
});

it('rejects an invalid save request before opening a collection', async () => {
  let called = false;

  const run: OperationRunner = async () => {
    called = true;
    throw new Error('The invalid request must not run an operation');
  };

  const handler = createSaveHandler(run);
  const result = responseBody(await handler(event('{"id":"saved"}'), context()));

  expect(result.response.statusCode).toBe(400);
  expect(called).toBe(false);
});
