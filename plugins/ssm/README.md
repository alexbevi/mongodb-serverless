# @mongodb-serverless/plugin-ssm

Reads a MongoDB connection string and cached topology from AWS Systems Manager
Parameter Store with one decrypted `GetParameters` request per plugin instance.
Concurrent reads share that request. The connection string must be a SecureString;
missing topology returns `null`.

## Install

```sh
npm install @mongodb-serverless/plugin-ssm
```

## Usage

```ts
import { SsmPlugin } from '@mongodb-serverless/plugin-ssm';

const plugin = new SsmPlugin({
  connectionStringParameter: '/my-app/mongodb/uri',
  topologyParameter: '/my-app/mongodb/topology'
});
const uri = await plugin.getConnectionString();
const topology = await plugin.read();
```

The AWS SDK uses its normal region and credential providers. Supply an `SSMClient`
through `client` to configure an endpoint or share an existing SDK client.
The default parameter names are `/mongodb-serverless/connection-string` and
`/mongodb-serverless/topology`.

## Limitations

This version reads existing topology only. It cannot yet persist discovery.
The caller needs `ssm:GetParameters` on both parameter ARNs and `kms:Decrypt`
when using a customer-managed key. Cached settings last for the plugin instance;
create a new instance to reload a rotated connection string. Failed requests are
not cached. The response is matched by parameter name because SSM sorts results.
