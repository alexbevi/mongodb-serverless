# Plugins

A plugin answers one question for
[`@mongodb-serverless/driver`](../driver): where does the cluster topology
live, and how do I read and write it there.

The driver needs a `replSetGetStatus` document to decide which member serves
reads and which serves writes. It will not go and discover that itself, because
discovering it per request is the cost this whole project exists to avoid. So
something else has to put that document somewhere, and a plugin is the adapter
to that somewhere. An environment variable locally, a parameter store or a
shared cache in a deployment.

## Strategy

**Plugins are chosen in code, never from the environment.** The driver reads no
variable to decide what to load. A plugin arrives as an instance or a package
name, so the choice is visible at the call site and easy to swap in a test.

```ts
new MongoClient(uri, { plugin: new LocalPlugin() });
new MongoClient(uri, { plugin: '@mongodb-serverless/plugin-local' });
setDefaultPlugin(new LocalPlugin());   // once at startup
```

**The driver depends on no plugin package.** Not even optionally. A test
enforces it. Publishing a plugin never requires a driver release.

**Plugins are validated structurally, never with `instanceof`.** The driver
checks that `setup`, `verify`, `read`, and `write` are functions and that
`name`, `version`, and `author` are strings. `instanceof` returns false across
two copies of the same class, which is what a dependency tree holding two
versions of a shared base produces, so a valid plugin would be rejected for
where it happened to be installed.

That has a useful consequence: **a plugin does not have to extend anything.**
Any object of the right shape works. [`shared/`](shared) holds an abstract
class that supplies the config plumbing and the defaults, but it is a
convenience, not a requirement.

**The shared contract is not published.** It compiles into each plugin's own
`dist`, so a plugin has no runtime dependency to resolve and the contract needs
no version or release of its own. A `workspace:*` dependency would make a
published plugin uninstallable with npm, which fails with
`EUNSUPPORTEDPROTOCOL`.

## Default configuration

Every plugin inherits these, and may add its own by widening the config type.
Read and change them with `get()` and `set()`.

| Key | Default | Meaning |
|---|---|---|
| `refreshIntervalMS` | `10000` | How often the watcher refreshes stored topology |
| `clusterTopologyVariableName` | `__MONGODB_CLUSTER_TOPOLOGY` | Names where the topology document lives |

`clusterTopologyVariableName` is on the shared contract rather than on any one
plugin, because every plugin has to name the location holding the document.
Only the meaning of that name changes: an environment variable for
`plugin-local`, and a parameter path, secret id, or cache key for others.

## Available plugins

| Plugin | Package | Directory | Stores topology in | Use for |
|---|---|---|---|---|
| Local Environment | `@mongodb-serverless/plugin-local` | [`local/`](local) | A process environment variable | Local development |

More to come as the watcher's design settles. A plugin backed by a shared store
is what a deployment needs, since a process environment cannot be updated from
outside the process when a failover happens.

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
  async write(status: ReplSetGetStatus): Promise<void> {} // replace it
}
```

`verify()` should throw with a message naming what is wrong, since that message
is what a user sees when their topology is missing or malformed.

The driver resolves a plugin from a package by checking a `default` export, a
`plugin` or `Plugin` export, then every other named export, so exporting the
class under its own name is fine. A class is constructed with no arguments.

See [`shared/README.md`](shared) for the full contract and
[`local/`](local) for a worked example.
