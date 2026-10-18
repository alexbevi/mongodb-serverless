# @mongodb-serverless/driver

Replaces the driver's `MongoClient` with one that routes operations directly to
replica-set members. It reads cached topology from a plugin, or discovers and
stores it on first use. Discovery requires permission to run `replSetGetStatus`.

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

When the plugin implements `getConnectionString()`, omit the explicit URI with
`new MongoClient(undefined, { plugin })`. Pass a database name to `db(name)` in
this form: the plugin resolves asynchronously, so its default database is not
available when `db()` is called. An explicit URI takes precedence. Credentials
remain in the plugin's connection-string store; topology documents contain no
copy of them.

On a cache miss, a temporary native MongoDB client uses the original URI and
constructor options for DNS resolution, authentication, and replica-set discovery.
It closes after reading topology. Cached routing and refresh through known
members use direct connections without SRV or TXT lookups.

Supply `authSource` in the URI or constructor options when authentication depends
on a DNS TXT default, such as `authSource=admin`. TXT defaults used during discovery
are not carried into routed clients. TLS remains enabled by default for SRV URIs.

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

### Disable monitoring

Opt in with `disableMonitoring: true` on the wrapper. It applies to both lazy
clients, including clients returned by `createClient`. The default remains
unchanged.

The same patch works on a native client without a plugin. Install
`mongodb@^7.7.0`, then call the helper before connecting or issuing an operation.
In this example, `uri` names one replica set member.

```js
import { MongoClient } from 'mongodb';
import { disableMonitoring } from '@mongodb-serverless/driver/no-monitoring';

const client = disableMonitoring(new MongoClient(uri, {
  directConnection: true,
  maxPoolSize: 1,
  minPoolSize: 0
}));

try {
  await client.connect();
  await client.db('admin').command({ listDatabases: 1 });
} finally {
  await client.close();
}
```

The first socket completes the native handshake and authentication, then enters
the application pool. No heartbeat or RTT sockets, timers, or heartbeat events
run for this client. Command monitoring and pool events still work. Pool sizes
remain configurable; minimum-pool maintenance can open application connections.

On a standalone native client, the monitoring patch reconnects to the same host
and retains native retry rules. On the serverless wrapper, topology-related write
failures also trigger the plugin refresh described below. The wrapper disables
native write retries so it can bound its own retry count. Closing a patched
client never reconnects to end sessions.

This experimental patch uses 7.7.0 as its verified baseline. It accepts stable
versions in `>=7.7.0 <8.0.0` when the internal API checks pass. Those checks cannot
guarantee unchanged behavior in private driver APIs. It supports data-bearing
replica set members, no authentication or SCRAM, and TLS. It rejects standalone, sharded, load-balanced, and automatically
encrypted clients, along with other authentication mechanisms. It installs
process-wide hooks that delegate unchanged for clients without the opt-in.
Importing the helper alone does not install those hooks. Pass a client from the
same physical `mongodb` installation that the package resolves.

From a checkout, `npm run test:no-monitoring:package` installs a tarball and runs
this example as ESM and CommonJS on Node 20.19 and the current runtime. It needs
Docker and OpenSSL.

`npm run benchmark:no-monitoring` compares stock polling with the patch under
TLS and SCRAM-SHA-256. It alternates 100 fresh processes per mode, then measures
100 operations on each reused client. Both modes use a pool limit of one and
disable retries. The report includes median and p95 timings, plus TCP socket
counts, in `tools/benchmarks/no-monitoring-results.json`. These are local Docker
measurements; Lambda cold starts need their own measurements.

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
across member changes, and a session cannot leave the client
that created it.

**A few mongodb exports are missing.** The driver marks some of its runtime
exports as internal, and those are not re-exported here. `INTERNAL_MONGODB_EXPORTS`
lists them; import them from `mongodb` directly if you need one.

**`estimatedDocumentCount` can disagree with `countDocuments`.** It reads
collection metadata, which lags on a secondary. `countDocuments` aggregates and
does not.

**Replica sets only.** Sharded and load-balanced clusters do not report their
topology through `replSetGetStatus`.

**Read failures do not refresh topology.** A client serving only reads can keep
using stale topology until it is replaced. Topology-related write failures refresh
the cached members. There is no background polling.

### Discovery and write recovery

A topology-related write failure triggers one shared refresh per client after
100–249 ms of jittered backoff. An ordinary promise-returning write rejected with `NotWritablePrimary` or
`NotPrimaryNoSecondaryOk` is attempted once more against the refreshed primary.
A `NoWritesPerformed` label on a topology-related server error also permits replay.
Explicit sessions, bulk builders, and cursors are excluded from automatic replay.
Network failures and partial bulk failures refresh topology but are returned to
the caller: their writes may already have run. Duplicate-key, validation, and
authorization errors do not trigger discovery. A failed refresh preserves the
original write error. The caller decides whether to retry again after an election.

Bulk builders and cursors also refresh topology on topology-related failures,
but their state is not replayed automatically. A bulk may have committed earlier
batches, and a cursor may already have returned results or performed writes.
Create a new operation after handling the error.

Refresh tries the cached members, so losing the original seed does not prevent
recovery. Each attempt uses a temporary direct client and closes it afterward.
The default server-selection timeout is five seconds for initial discovery and
five seconds per cached member during refresh. An explicit
`serverSelectionTimeoutMS` overrides it.

See [architecture and plugin sequences](../docs/architecture.md) for the storage
contract, migration notes, and concurrency limits.
