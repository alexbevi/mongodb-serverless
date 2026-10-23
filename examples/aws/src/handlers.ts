export interface ExampleDocument {
  _id: string;
  value: string;
  updatedAt?: Date;
}

interface UpdateResult {
  acknowledged: boolean;
  matchedCount: number;
  upsertedCount: number;
}

export interface ExampleCollection {
  findOne(filter: { _id: string }, options: { readPreference: 'nearest' }): Promise<ExampleDocument | null>;
  updateOne(
    filter: { _id: string },
    update: { $set: { value: string }; $currentDate: { updatedAt: true } },
    options: { upsert: true }
  ): Promise<UpdateResult>;
}

export interface ApiEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: { id?: string } | null;
}

export interface LambdaContext {
  callbackWaitsForEmptyEventLoop: boolean;
}

export interface ApiResponse {
  statusCode: number;
  headers: { 'content-type': string; 'server-timing': string };
  body: string;
}

export interface OperationMeasurement<Result> {
  result: Result;
  ssmMs: number;
  connectMs: number;
  operationMs: number;
}

export interface OperationRunner {
  <Result>(operation: (collection: ExampleCollection) => Promise<Result>): Promise<OperationMeasurement<Result>>;
  close(): Promise<void>;
}

export type ApiHandler = (event: ApiEvent, context: LambdaContext) => Promise<ApiResponse>;

export function createFindHandler(
  run: OperationRunner,
  drainAfterWarm = process.env['BENCHMARK_DRAIN_AFTER_WARM'] === 'true'
): ApiHandler {
  let cold = true;

  return async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    const id = validId(event.queryStringParameters?.id ?? 'example');
    const invocationIsCold = cold;
    cold = false;

    if (id === undefined) {
      return response(400, invocationIsCold, 0, 0, 0, { error: 'id must contain 1–100 URL-safe characters' });
    }

    const measured = await measureOperation(
      run,
      collection => collection.findOne({ _id: id }, { readPreference: 'nearest' }),
      drainAfterWarm && !invocationIsCold
    );

    return response(
      measured.result === null ? 404 : 200,
      invocationIsCold,
      invocationIsCold ? measured.ssmMs : 0,
      measured.connectMs,
      measured.operationMs,
      { document: measured.result }
    );
  };
}

export function createSaveHandler(
  run: OperationRunner,
  drainAfterWarm = process.env['BENCHMARK_DRAIN_AFTER_WARM'] === 'true'
): ApiHandler {
  let cold = true;

  return async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    const request = saveRequest(event);
    const invocationIsCold = cold;
    cold = false;

    if (request === undefined) {
      return response(
        400, invocationIsCold, 0, 0, 0,
        { error: 'body must contain a string value and an optional URL-safe id' }
      );
    }

    const id = request.id ?? 'example';

    const measured = await measureOperation(
      run,
      collection => collection.updateOne(
        { _id: id },
        { $set: { value: request.value }, $currentDate: { updatedAt: true } },
        { upsert: true }
      ),
      drainAfterWarm && !invocationIsCold
    );

    return response(
      200, invocationIsCold, invocationIsCold ? measured.ssmMs : 0,
      measured.connectMs, measured.operationMs,
      {
        id, acknowledged: measured.result.acknowledged,
        matched: measured.result.matchedCount, upserted: measured.result.upsertedCount
      }
    );
  };
}

interface SaveRequest {
  id?: string;
  value: string;
}

type ResponseBody =
  | { error: string }
  | { document: ExampleDocument | null }
  | { id: string; acknowledged: boolean; matched: number; upserted: number };

function saveRequest(event: ApiEvent): SaveRequest | undefined {
  if (!event.body) return undefined;

  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const value: unknown = JSON.parse(text);

    if (!isSaveRequest(value)) return undefined;

    const id = value.id ?? 'example';

    return validId(id) === undefined || value.value.length > 1_000 ? undefined : value;
  } catch {
    return undefined;
  }
}

function isSaveRequest(value: unknown): value is SaveRequest {
  if (value === null || typeof value !== 'object') return false;

  return 'value' in value && typeof value.value === 'string' &&
    (!('id' in value) || value.id === undefined || typeof value.id === 'string');
}

function validId(value: string): string | undefined {
  return /^[A-Za-z0-9._~-]{1,100}$/.test(value) ? value : undefined;
}

async function measureOperation<Result>(
  run: OperationRunner,
  operation: (collection: ExampleCollection) => Promise<Result>,
  drain: boolean
): Promise<OperationMeasurement<Result>> {
  try {
    return await run(operation);
  } finally {
    if (drain) await run.close();
  }
}

function response(
  statusCode: number,
  coldStart: boolean,
  ssmMs: number,
  connectMs: number,
  operationMs: number,
  result: ResponseBody
): ApiResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'server-timing': [
        `ssm;dur=${ssmMs.toFixed(3)}`,
        `connect;dur=${connectMs.toFixed(3)}`,
        `operation;dur=${operationMs.toFixed(3)}`
      ].join(', ')
    },
    body: JSON.stringify({ ...result, timing: { coldStart, ssmMs, connectMs, operationMs } })
  };
}
