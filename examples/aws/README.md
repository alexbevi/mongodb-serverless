# AWS Lambda examples

## Purpose

These examples expose the same MongoDB `find` and `save` operations through one Regional API Gateway API:

| Variant | Read | Write | Connection settings |
| --- | --- | --- | --- |
| Native MongoDB driver | `/native/find` | `/native/save` | Operation-specific URI from SSM Parameter Store |
| Serverless driver without a plugin | `/no-plugin/find` | `/no-plugin/save` | Operation-specific URI from SSM Parameter Store |
| Serverless driver with `aws-ssm` | `/aws-ssm/find` | `/aws-ssm/save` | Operation-specific URI and cached topology from one SSM request |

Each handler follows [MongoDB's Lambda connection guidance](https://www.mongodb.com/docs/atlas/manage-connections-aws-lambda/): initialization work runs outside the handler, while the MongoDB client is created only when a valid request needs it and is retained for warm invocations. The find handlers use `nearest`; writes use MongoDB's primary write routing.

The build uses [esbuild, as documented by AWS for TypeScript Lambda functions](https://docs.aws.amazon.com/lambda/latest/dg/typescript-package.html). It emits one minified ZIP for each handler and includes the complete MongoDB driver dependency tree in every variant so package loading is comparable. The API uses the [Regional endpoint type](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-endpoint-types.html).

## Install

From the repository root:

```sh
pnpm install
```

The default deployment expects read and write MongoDB connection strings in `/mongodb-serverless-pattern/uri` and `/mongodb-serverless-examples/write-uri`. Both must be `SecureString` parameters and use SRV connection strings if the no-plugin example should exercise DNS discovery. The default namespace is `mongodb_serverless_prod.serverless_patterns`. Pass `--read-connection-string-parameter`, `--write-connection-string-parameter`, `--database`, or `--collection` to change these values.

## Usage

Build the six deployment packages:

```sh
pnpm examples:aws:build
```

Deploy the `mongodb-serverless-examples` CloudFormation stack with an API key, six arm64 Node.js 24 Lambda functions, and a Regional REST API:

```sh
pnpm examples:aws:deploy -- --profile personal --region ap-southeast-2
```

The response includes the application result and handler timing:

```json
{
  "document": { "_id": "example", "value": "hello" },
  "timing": { "coldStart": true, "ssmMs": 40, "connectMs": 50, "operationMs": 10 }
}
```

Run paired cold and warm requests for every endpoint:

```sh
pnpm examples:aws:measure -- --profile personal --region ap-southeast-2 --samples 20
```

The measurement command changes a harmless Lambda environment nonce before each cold request, waits for the update, then sends one cold request and one warm request. It seeds the shared document and cached topology before collecting samples. During a measurement run, a Lambda environment setting closes the retained client after the warm operation so repeated cold starts do not leave sockets in retiring environments. The command removes that setting when it finishes. The report uses the timing returned by the handler, so API Gateway, caller network latency, and benchmark cleanup are excluded. `ssmMs` measures the eager SSM request during Lambda initialization. Native and no-plugin handlers fetch one connection string; `aws-ssm` fetches the connection string and cached topology together. Warm responses report `ssmMs` as zero. `connectMs` and `operationMs` contain only handler work.

The source entry points are under [`src/native`](./src/native), [`src/no-plugin`](./src/no-plugin), and [`src/aws-ssm`](./src/aws-ssm).

## Limitations

These examples support replica sets only. They do not cover sharded or load-balanced deployments, change streams, or sessions spanning read and write clients.

The bundles use the AWS SDK v3 supplied by the Node.js Lambda runtime to keep the deployment packages small. Bundle the SDK if the application must pin its exact version.

The API key limits accidental access but is not an application authentication scheme. Delete the example stack when it is no longer needed.
