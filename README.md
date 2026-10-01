# MongoDB Serverless Driver

A wrapper around the [MongoDB Node.js driver](https://github.com/mongodb/node-mongodb-native)
that skips topology discovery on connect.

In a serverless runtime, every cold start pays for the driver's normal startup
work: handshake each replica set member, elect a view of the topology, then
select a server. The instance serves one request and throws that away. This
wrapper moves discovery out of the request path. A watcher process keeps the
output of `replSetGetStatus` in a store, a plugin reads it, and the driver
opens a `directConnection` straight to the member it needs.

Reads go to a secondary, writes go to the primary, each on its own client,
created on first use.

## Components

| Directory | Package | What it does |
|---|---|---|
| `driver/` | `@mongodb-serverless/driver` | Replaces `MongoClient` and routes operations to a read or write client |
| `watcher/` | `@mongodb-serverless/watcher` | Refreshes stored topology on an interval. Not yet implemented |
| `plugins/shared/` | not published | The plugin contract, compiled into each plugin |
| `plugins/local/` | `@mongodb-serverless/plugin-local` | Reads topology from an environment variable |

## Quickstart

Change the import, pick a plugin, and leave the rest of your code alone.

```ts
import { MongoClient } from '@mongodb-serverless/driver';
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

const client = new MongoClient(uri, { plugin: new LocalPlugin() });

await client.db('app').collection('users').insertOne({ n: 1 }); // primary
await client.db('app').collection('users').find({}).toArray();  // secondary
```

Every other export (`ObjectId`, `ReadPreference`, the error classes) passes
through to the real driver unchanged.

Populate the topology from a running cluster:

```sh
export __MONGODB_CLUSTER_TOPOLOGY="$(mongosh --quiet --eval 'JSON.stringify(rs.status())')"
```

## Scope

v1 supports replica sets only. Sharded and load-balanced clusters report
topology through commands other than `replSetGetStatus`, so they need a
different source. Change streams and sessions that span the read and write
client are also unsupported. See `driver/README.md` for the details and the
reasoning.

The watcher is not implemented. Until it is, the stored topology is only as
current as whatever last wrote it, which is fine for local development and not
for a deployment where a failover can happen.

## Development

```sh
pnpm install
pnpm test              # everything, including the real cluster
pnpm test:unit         # no Docker, no build, for a fast loop
pnpm test:integration  # just the cluster suite
pnpm typecheck
```

The integration suite runs against a real 3-node replica set that
`driver/test/harness/cluster.ts` starts in Docker on demand and reuses across
runs. Without Docker it skips. `pnpm cluster:stop` removes the container; the
next run rebuilds it in about 30 seconds.

Requires Node 20.19 or later. See `AGENTS.md` for the working agreement.
