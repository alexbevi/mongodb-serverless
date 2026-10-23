# @mongodb-serverless/plugin-local

Stores replica-set topology and reads the cluster connection string in the
current process environment. Use it for local development.

## Install

```sh
npm install @mongodb-serverless/plugin-local
```

## Usage

```ts
import { MongoClient } from '@mongodb-serverless/driver';
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

const plugin = new LocalPlugin();
const client = new MongoClient(uri, { plugin });
await client.db('app').collection('users').insertOne({ n: 1 });
await client.close();
```

Leave `__MONGODB_CLUSTER_TOPOLOGY` unset for first-run discovery. `read()` returns
`null` for an absent or empty variable, and throws for malformed JSON or status.
`write()` replaces the variable with the JSON status document, including the
authentication mechanism and resolved source added by discovery. Credentials
remain in the connection string or driver options.

To supply credentials through the plugin, set `__MONGODB_CONNECTION_STRING`
and construct `new MongoClient({ plugin })`. Use an explicit database
name in `db(name)` with this form. Connection strings are kept separate from
topology documents.

Override variable names with `plugin.set('clusterTopologyVariableName', 'MY_TOPOLOGY')`
and `plugin.set('connectionStringVariableName', 'MY_URI')`.

The plugin is writable by default. `{ writable: false }` prevents updates and
causes discovery to fail with `PluginReadOnlyError` when it needs to store topology.
`setup()` does nothing; `verify()` validates a populated topology variable and
throws if it is missing. The driver calls `setup()` on a cache miss, but does not
call `verify()` automatically.

## Limitations

Environment updates only affect this process. They do not update Lambda
configuration, another process, or later cold starts. Use a shared-store plugin
for persistence across instances. Concurrent clients in one process share the
same variable; separate clusters or authentication defaults need separate
variable names.

Replica sets only. Sharded and load-balanced clusters, change streams, and
sessions spanning read and write clients are unsupported by the driver.
