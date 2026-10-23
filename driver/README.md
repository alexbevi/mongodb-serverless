# @mongodb-serverless/driver

Replaces the driver's `MongoClient` with one that routes operations directly to
replica-set members. It discovers topology when routing needs it and remembers it for
that client. An optional plugin shares topology across client instances.
Discovery requires permission to run `replSetGetStatus`.

## Install

```sh
npm install @mongodb-serverless/driver mongodb
```

`mongodb` is a peer dependency, so you control its version. No plugin is a
dependency of this package. Install whichever one you use.

## Usage

Change `from 'mongodb'` to `from '@mongodb-serverless/driver'`. Check the
limitations below before replacing an existing client.

```ts
import { MongoClient, ObjectId } from '@mongodb-serverless/driver';

const client = new MongoClient(uri);
```

`ObjectId` here is the real driver's class. Only `MongoClient` is ours.

### Supplying a plugin

By instance, which TypeScript checks at compile time:

```ts
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

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

An explicit `plugin` option wins over `setDefaultPlugin`. With neither, supply
a URI: topology stays in memory for that client and is not persisted. There is
no environment variable for choosing a plugin, though a plugin may read the
environment for its own configuration.

When the plugin implements `getConnectionString()`, omit the explicit URI with
`new MongoClient(plugin)`. If other driver options are needed, use
`new MongoClient({ plugin, ...options })`. Pass a database name to `db(name)` in
this form: the plugin resolves asynchronously, so its default database is not
available when `db()` is called. An explicit URI takes precedence. Credentials
remain in the plugin's connection-string store; topology documents contain no
copy of them.

On a cache miss, the native driver's URI parser and SRV/TXT resolver produce the
seed list and connection settings. The wrapper tries seeds in random order,
connecting directly to one member at a time. It retains a successful connection
for operations targeting that member. Cached routing and refresh through known
members perform no SRV or TXT lookups. Discovery uses the initial handshake for
replica-set identity and member address checks; it sends no additional `hello`.

SRV resolution uses an internal driver API, verified against `mongodb@7.7.0`.
It requires a stable version in `>=7.7.0 <8.0.0`; recheck DNS and authentication
behavior on driver upgrades.

Discovery stores the authentication mechanism and the native driver's resolved
`authSource` alongside topology. Direct read, write, and refresh connections reuse
that source, including when another wrapper reads the cached topology. Explicit
`authSource` in the URI or constructor options takes precedence. Passwords,
certificates, tokens, and provider callbacks come from each wrapper's original
configuration; they are never stored in topology. TLS remains enabled by default
for SRV URIs; an explicit `tls: false` or `ssl: false` constructor option is
preserved for bootstrap and cached connections.

Use separate topology records for different clusters or authentication defaults.
Changing the authentication mechanism triggers native discovery again. Older
records without authentication metadata still work with explicit `authSource`;
clear them once to discover a source supplied only by DNS TXT.

## Routing

A method table decides where each operation goes. `insertOne` and `updateMany`
are writes. `find` and `distinct` are reads. `aggregate` is a read unless its
last stage is `$out` or `$merge`, matching how the driver itself detects a write
stage.

An explicit `readPreference` overrides the table, so
`find(q, { readPreference: 'primary' })` goes to the write client.

Reads reuse an existing healthy secondary connection. Otherwise, the read
client connects to the first member whose `stateStr` is `SECONDARY` with
`health: 1`. With no healthy secondary, reads fall back to the primary,
which is what a single-node set needs.

An explicit operation `readPreference: 'nearest'` can reuse an already connected
primary or secondary, including the bootstrap connection. This permits either
role but does not implement latency, tag, or staleness filtering; use it only when
any healthy member is acceptable. Other preferences retain the limitations below.

Without a plugin, the native handshake identifies the connected member's role.
If it can serve the operation, the wrapper returns the result without running
`replSetGetStatus`. Later operations reuse that connection while its reported
role remains suitable. An operation needing another role first discovers
topology on the existing connection, then connects to the required member.
Discovery failures affect only operations that need discovery; later calls can
retry. Role mismatches and eligible write failures trigger the recovery below.

Plugin cache misses still discover and persist before executing operations.
The bootstrap connection is reused for its member; other connections open on
first use. When reads fall back to the primary, one client serves both.
`close()` closes every client it opened.

Before returning a routed client, the wrapper checks the role reported by the
native driver against the cached topology. A mismatch triggers one discovery
refresh, awaits the plugin's topology write, and selects the member again. A
second mismatch fails before sending the application operation. Matching roles
need no extra `hello` command. The check uses native server-description events;
with monitoring disabled, it does not poll reused connections for role changes.
An election can still occur between validation and execution.

### Disable monitoring

Opt in with `disableMonitoring: true` on the wrapper. It applies to bootstrap,
routed, and refresh connections, including clients returned by `createClient`.
Monitoring remains enabled by default.

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

With `maxPoolSize: 1` and `minPoolSize: 0`, healthy bootstrap and sequential
operations open one socket if the selected member can serve the operation, or
two if another member is needed. No plugin is required. The first connection is
retained; later reads prefer an already connected healthy secondary. Failed
seeds, elections, and replacement of idle connections can increase the count.
See [the bootstrap diagrams](../docs/bootstrap.md).

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

The native cursor is not created until the first terminal call
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
| `MissingPluginError` | Neither a URI nor a plugin supplied by option or `setDefaultPlugin` |
| `PluginNotInstalledError` | A plugin named by string could not be resolved |
| `InvalidPluginError` | The plugin is missing required members, which the message names |
| `NoTopologyError` | The plugin returned no topology |
| `InvalidTopologyError` | The topology document is malformed |
| `NoPrimaryError` | No member reports `PRIMARY` |
| `SessionRoutingError` | A session was passed to an operation that routes to the secondary |
| `UnsupportedOperationError` | `watch()`, which v1 does not support |

## Limitations

**Read preferences do not yet match the native driver.** The default is
secondary-first. Inherited preferences, strict-secondary fallback, tags,
staleness, latency selection, and some command routes have known differences.
Database and collection options are discarded, including read and write concern.
Role validation does not resolve these differences. See the
[preference comparison and executable tests](../docs/operation-preferences.md).

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

**Errors from an executed read do not refresh topology.** A role mismatch
detected before routing does refresh it. With monitoring disabled, a reused
connection is not polled, so later role changes can remain unnoticed.
Topology-related write failures also refresh the cached members.

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
Create a new operation after handling the error. If async iteration and cursor
cleanup both fail, the original iteration error is returned.

Refresh tries the cached members, so losing the original seed does not prevent
recovery. Each attempt uses a temporary direct client and closes it afterward.
The default server-selection timeout is five seconds per seed during initial
discovery or refresh. An explicit
`serverSelectionTimeoutMS` overrides it.

See [architecture and plugin sequences](../docs/architecture.md) for the storage
contract, migration notes, and concurrency limits.
