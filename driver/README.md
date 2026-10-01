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
first operation throws `MissingPluginError`.

Plugin selection is always explicit in code. The driver reads no environment
variable to decide which plugin to load, though a plugin may read the
environment for its own configuration.

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

`find`, `aggregate`, `listIndexes`, `listSearchIndexes`, `listCollections`, and
`runCursorCommand` hand back a cursor synchronously, but routing has to read
the topology first. They return a cursor that configures nothing until you
await it:

```ts
const docs = await collection.find({ a: 1 }).sort({ b: -1 }).limit(10).toArray();
```

Chained calls are buffered and replayed in order against the real cursor, which
is created by the first terminal call (`toArray`, `next`, `hasNext`, `forEach`,
`for await`). A cursor you never read opens no connection.

The same applies to `initializeOrderedBulkOp` and `initializeUnorderedBulkOp`,
whose operations replay on `execute()`.

One consequence: a property that only exists once the cursor does, such as
`cursor.id` or `cursor.namespace`, throws if read before a terminal call rather
than returning `undefined`.

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
`withTransaction`. Routing session operations to the primary instead is a small
change, and worth making once real usage shows whether this is too strict.

**`watch()` and `startSession()` throw.** Change streams need a resume story
that belongs with the watcher's design. `startSession()` cannot work while a
session is confined to one client.

**Nine mongodb exports are omitted.** `CancellationToken`,
`ChangeStreamCursor`, `MongoClientAuthProviders`, and six server selection and
SRV polling event classes are exported at runtime but marked "Excluded from
this release type" in `mongodb.d.ts`, so re-exporting them would not typecheck.
Import them from `mongodb` directly if you need them. The full list is
`INTERNAL_MONGODB_EXPORTS`.

**`estimatedDocumentCount` can disagree with `countDocuments`.** It reads
collection metadata, which lags on a secondary. `countDocuments` aggregates and
does not.

**Replica sets only.** Sharded and load-balanced clusters do not report their
topology through `replSetGetStatus`.

**Topology is read once per client.** There is no refresh while a client lives.
`refreshIntervalMS` on the plugin base exists for the watcher to use.
