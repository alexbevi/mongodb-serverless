# @mongodb-serverless/watcher

Polls a replica set and writes its topology through a plugin, so
[`@mongodb-serverless/driver`](../driver) can route without discovering
anything itself.

## Install

```sh
npm install @mongodb-serverless/watcher mongodb
```

Plus whichever plugin stores the topology.

## Usage

The watcher is the only writer, so its plugin must be constructed writable.

```ts
import { Watcher } from '@mongodb-serverless/watcher';
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

const watcher = new Watcher({
  uri: 'mongodb://user:pass@host:27017/?replicaSet=rs0',
  plugin: new LocalPlugin({ writable: true })
});

await watcher.check();   // one cycle
```

`check()` verifies the connection with `hello`, reads `replSetGetStatus`, and
writes it back. It returns the set name and member count.

To keep the topology current, poll:

```ts
watcher.start();                 // a cycle now, then every refreshIntervalMS
await watcher.stop();            // stop polling and close the connection
```

A failed cycle does not stop the loop. Pass `onError` to see failures:

```ts
new Watcher({ uri, plugin, onError: error => console.error(error) });
```

`plugin` takes an instance or a package name, the same two forms the driver
accepts.

For tests, `createClient` can return a `ClusterClient` with `connect()`,
`db(name).command()`, and `close()`. The watcher awaits `connect()` before
sending commands. An ordinary `MongoClient` also satisfies this contract.

## Errors

| Error | Cause |
|---|---|
| `ClusterUnreachableError` | Connection refused, host not found, or selection timed out |
| `AuthenticationFailedError` | The credentials were rejected |
| `NotAReplicaSetError` | Reachable, but a standalone or a mongos |
| `MissingPluginError` | No plugin configured |
| `PluginReadOnlyError` | The plugin was not constructed writable |

Each keeps the driver's own error as its `cause`, and none include the
password from the connection string.

Match on `name` rather than `instanceof` when catching these across a package
boundary. The plugin contract compiles into each package, so the driver and the
watcher hold separate copies of the shared classes.

## Limitations

**Replica sets only.** A standalone has no topology to watch, and a mongos
reports sharded topology through other commands.

**No deduplication.** Every cycle writes. `replSetGetStatus` changes `date` and
each member's `uptime` on every call, so comparing documents would report a
change every time anyway.

**Failover is only noticed on the next cycle.** Between a step-down and that
cycle, the stored topology names a member that is no longer primary and the
driver's writes will fail. A shorter `refreshIntervalMS` narrows the window
without closing it.

**One cluster per watcher.** Watching several means several instances.
