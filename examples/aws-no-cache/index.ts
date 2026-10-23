import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MongoClient as MongoServerlessClient } from '@mongodb-serverless/driver';

interface Document {
  _id: string;
  value: string;
}

interface SaveDocument {
  id: string;
  value: string;
}

interface ErrorResponse {
  error: string;
}

const uri = process.env['MONGODB_URI'];

if (!uri) throw new Error('MONGODB_URI is required');

const client = new MongoServerlessClient(uri);

const documents = client
  .db(process.env['MONGODB_DATABASE'] ?? 'app')
  .collection<Document>(process.env['MONGODB_COLLECTION'] ?? 'documents');

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  switch (event.rawPath) {
    case '/find': {
      const id = event.queryStringParameters?.['id'];

      if (!isValidId(id)) return json(400, { error: 'id must contain 1–100 URL-safe characters' });

      const document = await documents.findOne({ _id: id }, { readPreference: 'nearest' });

      return json(document ? 200 : 404, document ?? { error: 'not found' });
    }

    case '/save': {
      const document = saveBody(event.body);

      if (!document) return json(400, { error: 'body must contain URL-safe id and string value' });

      await documents.updateOne({ _id: document._id }, { $set: { value: document.value } }, { upsert: true });

      return json(200, document);
    }

    default:
      return json(404, { error: 'not found' });
  }
}

function saveBody(body: string | null | undefined): Document | undefined {
  try {
    const value: unknown = JSON.parse(body ?? '');

    if (!isSaveDocument(value)) return undefined;

    return { _id: value.id, value: value.value };
  } catch {
    return undefined;
  }
}

function isSaveDocument(value: unknown): value is SaveDocument {
  return value !== null && typeof value === 'object' &&
    'id' in value && isValidId(value.id) &&
    'value' in value && typeof value.value === 'string';
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,100}$/.test(value);
}

function json(statusCode: number, body: Document | ErrorResponse): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
