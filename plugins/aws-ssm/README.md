# @mongodb-serverless/plugin-aws-ssm

Reads a MongoDB connection string and cached topology from AWS Systems Manager
Parameter Store with one decrypted [`GetParameters`](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameters.html) request per plugin instance.
Concurrent reads share that request. The connection string must be a SecureString;
missing topology returns `null`.

## Install

```sh
npm install @mongodb-serverless/plugin-aws-ssm
```

## Usage

```ts
import { MongoClient } from '@mongodb-serverless/driver';
import { SsmPlugin } from '@mongodb-serverless/plugin-aws-ssm';

const plugin = new SsmPlugin({
  connectionStringParameter: '/my-app/mongodb/uri',
  topologyParameter: '/my-app/mongodb/topology'
});

const client = MongoClient.fromPlugin(plugin);
await client.db('app').collection('users').findOne({ name: 'Ada' });
const ssmMs = plugin.fetchDurationMs;
```

`fetchDurationMs` reports the duration of the shared `GetParameters` request after
it completes. It remains `undefined` before the first request.

The AWS SDK uses its normal region and credential providers. Supply an `SSMClient`
through `client` to configure an endpoint or share an existing SDK client.
The default parameter names are `/mongodb-serverless/connection-string` and
`/mongodb-serverless/topology`.

## Limitations

- Discovery and refresh overwrite only the topology parameter. Writes are on by
  default; pass `writable: false` for a store populated some other way.
- Permissions: `ssm:GetParameters` on both parameters, `ssm:PutParameter` on the
  topology parameter when writable, and `kms:Decrypt` with a customer-managed key.
- Topology holds only the set name, each member's name, role and health, and the
  resolved authentication mechanism and source. Credentials stay in the separate
  SecureString.
- The topology must fit the 4096-byte Standard parameter limit.
- Concurrent writers are last-write-wins, because SSM has no compare-and-swap.
- Settings are cached for the plugin's lifetime, so a rotated connection string
  needs a new plugin. Failed requests are not cached.

## Development

The LocalStack integration tests send real AWS SDK requests to an emulator; CI
runs them in the `plugin-aws-ssm` job. Locally, start LocalStack 4.14.0 and run
the suite from the repository root:

```sh
docker run --rm --publish 127.0.0.1:4566:4566 --env SERVICES=ssm,kms localstack/localstack:4.14.0
SSM_ENDPOINT=http://127.0.0.1:4566 pnpm --filter @mongodb-serverless/plugin-aws-ssm test:integration
```

LocalStack checks API behaviour, not production IAM or KMS policy, AWS latency,
or routing. The driver's replica-set tests and the benchmark cover those.
