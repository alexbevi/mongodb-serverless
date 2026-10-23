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

export type CollectionProvider = () => ExampleCollection | Promise<ExampleCollection>;

export type ApiHandler = (event: ApiEvent, context: LambdaContext) => Promise<ApiResponse>;

export function createFindHandler(collection: CollectionProvider): ApiHandler {
  let cold = true;

  return async (event, context) => {
    const started = performance.now();
    context.callbackWaitsForEmptyEventLoop = false;
    const id = validId(event.queryStringParameters?.id ?? 'example');

    if (id === undefined) return response(400, started, useCold(), { error: 'id must contain 1–100 URL-safe characters' });

    const document = await (await collection()).findOne({ _id: id }, { readPreference: 'nearest' });

    return response(document === null ? 404 : 200, started, useCold(), { document });
  };

  function useCold(): boolean {
    const value = cold;
    cold = false;

    return value;
  }
}

export function createSaveHandler(collection: CollectionProvider): ApiHandler {
  let cold = true;

  return async (event, context) => {
    const started = performance.now();
    context.callbackWaitsForEmptyEventLoop = false;
    const request = saveRequest(event);
    const invocationIsCold = cold;
    cold = false;

    if (request === undefined) {
      return response(400, started, invocationIsCold, { error: 'body must contain a string value and an optional URL-safe id' });
    }

    const id = request.id ?? 'example';

    const result = await (await collection()).updateOne(
      { _id: id },
      { $set: { value: request.value }, $currentDate: { updatedAt: true } },
      { upsert: true }
    );

    return response(200, started, invocationIsCold, {
      id, acknowledged: result.acknowledged, matched: result.matchedCount, upserted: result.upsertedCount
    });
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

function response(statusCode: number, started: number, cold: boolean, result: ResponseBody): ApiResponse {
  const handlerMs = performance.now() - started;

  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'server-timing': `handler;dur=${handlerMs.toFixed(3)}` },
    body: JSON.stringify({ ...result, cold, handlerMs })
  };
}
