# @mongodb-serverless/driver

Replaces the driver's `MongoClient` with one that reads a pre-discovered
topology from a plugin and routes each operation to a read or write client.

## Install

```sh
npm install @mongodb-serverless/driver mongodb
```

`mongodb` is a peer dependency, so you control its version. No plugin is a
dependency of this package. Install whichever one you use.

## Usage

Change `from 'mongodb'` to `from '@mongodb-serverless/driver'`. Nothing else in
your code changes.

```ts
import { MongoClient, ObjectId } from '@mongodb-serverless/driver';
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

const client = new MongoClient(uri, { plugin: new LocalPlugin() });
```

`ObjectId` here is the real driver's class. Only `MongoClient` is ours.

### Supplying a plugin

By instance, which TypeScript checks at compile time:

```ts
new MongoClient(uri, { plugin: new LocalPlugin() });
```

By package name, so no plugin import appears in your code:

```ts
new MongoClient(uri, { plugin: '@mongodb-serverless/plugin-local' });
```

Or once at startup, leaving existing call sites untouched:

```ts
import { setDefaultPlugin, MongoClient } from '@mongodb-serverless/driver';

setDefaultPlugin(new LocalPlugin());
const client = new MongoClient(uri);
```

An explicit `plugin` option wins over `setDefaultPlugin`. With neither, the
first operation throws `MissingPluginError`. There is no environment variable
for choosing a plugin, though a plugin may read the environment for its own
configuration.

## Routing

A method table decides where each operation goes. `insertOne` and `updateMany`
are writes. `find` and `distinct` are reads. `aggregate` is a read unless its
last stage is `$out` or `$merge`, matching how the driver itself detects a write
stage.

An explicit `readPreference` overrides the table, so
`find(q, { readPreference: 'primary' })` goes to the write client.

The read client connects to the first member whose `stateStr` is `SECONDARY`
with `health: 1`. With no healthy secondary, reads fall back to the primary,
which is what a single-node set needs.

Both clients are created on first use and reused. When reads fall back to the
primary, one client serves both. `close()` closes every client it opened.

### Cursors and bulk writes

Cursors work as they normally do:

```ts
const docs = await collection.find({ a: 1 }).sort({ b: -1 }).limit(10).toArray();
```

Under the hood the real cursor is not created until the first terminal call
(`toArray`, `next`, `hasNext`, `forEach`, `for await`), since routing has to
read the topology first. Chained calls are buffered and replayed in order, and
a cursor you never read opens no connection. `initializeOrderedBulkOp` and
`initializeUnorderedBulkOp` work the same way, replaying on `execute()`.

Bulk find modifiers stay on the find builder until an update or delete:

```ts
const bulk = collection.initializeOrderedBulkOp();
bulk.find({ key: 'example' }).upsert().updateOne({ $set: { value: 1 } });
await bulk.execute();
```

So a property that only exists once the cursor does, such as `cursor.id` or
`cursor.namespace`, throws if read before a terminal call rather than returning
`undefined`.

## Errors

| Error | Cause |
|---|---|
| `MissingPluginError` | No plugin supplied by option or `setDefaultPlugin` |
| `PluginNotInstalledError` | A plugin named by string could not be resolved |
| `InvalidPluginError` | The plugin is missing required members, which the message names |
| `NoTopologyError` | The plugin returned no topology |
| `InvalidTopologyError` | The topology document is malformed |
| `NoPrimaryError` | No member reports `PRIMARY` |
| `SessionRoutingError` | A session was passed to an operation that routes to the secondary |
| `UnsupportedOperationError` | `watch()`, which v1 does not support |

## Limitations

**Reads inside a transaction throw.** The driver rejects a session used with a
different client than the one that created it, so a session cannot span our
read and write clients. Any session-bearing operation that would route to the
secondary raises `SessionRoutingError`, which includes a read inside
`withTransaction`.

**`watch()` and `startSession()` throw.** Change streams need a resume story
that belongs with the watcher's design, and a session cannot leave the client
that created it.

**A few mongodb exports are missing.** The driver marks some of its runtime
exports as internal, and those are not re-exported here. `INTERNAL_MONGODB_EXPORTS`
lists them; import them from `mongodb` directly if you need one.

**`estimatedDocumentCount` can disagree with `countDocuments`.** It reads
collection metadata, which lags on a secondary. `countDocuments` aggregates and
does not.

**Replica sets only.** Sharded and load-balanced clusters do not report their
topology through `replSetGetStatus`.

**Topology is read once per client.** There is no refresh while a client lives.
