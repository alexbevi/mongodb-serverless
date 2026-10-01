# Plugins

A plugin tells [`@mongodb-serverless/driver`](../driver) where the cluster
topology is stored and how to read and write it there. An environment variable
locally, a parameter store or shared cache in a deployment.

## Strategy

**Plugins are chosen in code, never from the environment.** A plugin arrives as
an instance or a package name, so the choice is visible at the call site and
easy to swap in a test.

```ts
new MongoClient(uri, { plugin: new LocalPlugin() });
new MongoClient(uri, { plugin: '@mongodb-serverless/plugin-local' });
setDefaultPlugin(new LocalPlugin());   // once at startup
```

**The driver depends on no plugin package**, not even optionally, so publishing
a plugin never requires a driver release.

**Plugins are read-only unless constructed writable.** The driver only reads,
so it gets the safe default without doing anything. The watcher is the only
writer and asks for it:

```ts
new LocalPlugin()                    // driver: write() throws
new LocalPlugin({ writable: true })  // watcher: write() permitted
```

**A plugin does not have to extend anything.** The driver checks that `setup`,
`verify`, `read`, and `write` are functions and that `name`, `version`, and
`author` are strings, so any object of that shape works. [`shared/`](shared)
holds an abstract class that supplies the config plumbing and the defaults, and
is not published.

## Default configuration

Every plugin inherits these, and may add its own by widening the config type.
Read and change them with `get()` and `set()`.

| Key | Default | Meaning |
|---|---|---|
| `refreshIntervalMS` | `10000` | How often the watcher refreshes stored topology |
| `clusterTopologyVariableName` | `__MONGODB_CLUSTER_TOPOLOGY` | Names where the topology document lives |

`clusterTopologyVariableName` means an environment variable for
`plugin-local`, and would be a parameter path, secret id, or cache key for
other plugins.

## Available plugins

| Plugin | Package | Directory | Stores topology in | Use for |
|---|---|---|---|---|
| Local Environment | `@mongodb-serverless/plugin-local` | [`local/`](local) | A process environment variable | Local development |

A deployment needs a plugin backed by a shared store, since a process
environment cannot be updated from outside the process when a failover happens.

## Writing a plugin

Implement four methods and three string details:

```ts
import { ServerlessPlugin } from '../shared/src/index.js';

export class MyPlugin extends ServerlessPlugin {
  readonly name = 'My Store';
  readonly version = '1.0.0';
  readonly author = 'you';

  async setup(): Promise<void> {}                      // prepare the store
  async verify(): Promise<void> {}                     // throw if unusable
  async read(): Promise<ReplSetGetStatus> { /* ... */ } // fetch the document

  async write(status: ReplSetGetStatus): Promise<void> {
    this.assertWritable();                             // refuse if read-only
    // replace the stored document
  }
}
```

`verify()` should throw with a message naming what is wrong, since that message
is what a user sees when their topology is missing or malformed. `write()`
should call `assertWritable()` before touching the store, so a refused write
changes nothing.

The driver resolves a plugin from a package by checking a `default` export, a
`plugin` or `Plugin` export, then every other named export, so exporting the
class under its own name is fine. A class is constructed with no arguments.

See [`shared/README.md`](shared) for the full contract and
[`local/`](local) for a worked example.
