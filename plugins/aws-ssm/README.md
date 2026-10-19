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
import { SsmPlugin } from '@mongodb-serverless/plugin-aws-ssm';

const plugin = new SsmPlugin({
  connectionStringParameter: '/my-app/mongodb/uri',
  topologyParameter: '/my-app/mongodb/topology'
});
// Supply this plugin to new MongoClient(undefined, { plugin }).
const uri = await plugin.getConnectionString();
const topology = await plugin.read();
```

The AWS SDK uses its normal region and credential providers. Supply an `SSMClient`
through `client` to configure an endpoint or share an existing SDK client.
The default parameter names are `/mongodb-serverless/connection-string` and
`/mongodb-serverless/topology`.

## Limitations

Discovery and refresh overwrite only the topology parameter. Writes are enabled
by default; pass `writable: false` for a pre-populated read-only store. The caller
needs `ssm:PutParameter` on the topology ARN when writes are enabled.

Topology stores only the set name, member names/roles/health, and resolved
authentication mechanism/source. Credentials remain in the separate SecureString.
The compact topology must fit the 4096-byte Standard parameter limit. Concurrent
Lambda writers use last-write-wins; SSM provides no compare-and-swap here.
The caller needs `ssm:GetParameters` on both parameter ARNs and `kms:Decrypt`
when using a customer-managed key. Cached settings last for the plugin instance;
create a new instance to reload a rotated connection string. Failed requests are
not cached. The response is matched by parameter name because SSM sorts results.
