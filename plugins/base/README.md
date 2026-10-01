# @mongodb-serverless/plugin-base

The contract a topology source implements for
[`@mongodb-serverless/driver`](../../driver). A plugin answers one question:
where does the cluster topology live, and how do I read and write it there.

## Install

```sh
npm install @mongodb-serverless/plugin-base
```

Only needed if you are writing a plugin.

## The contract

```ts
interface PluginConfig {
  refreshIntervalMS: number;
  clusterTopologyVariableName: string;
}

abstract class ServerlessPlugin<C extends PluginConfig = PluginConfig> {
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly author: string;

  abstract setup(): Promise<void>;
  abstract verify(): Promise<void>;
  abstract read(): Promise<ReplSetGetStatus>;
  abstract write(status: ReplSetGetStatus): Promise<void>;

  get<K extends keyof C>(key: K): C[K];
  set<K extends keyof C>(key: K, value: C[K]): void;
}
```

`setup()` prepares the store. `verify()` throws if it is unusable, with a
message saying what is wrong. `read()` returns the stored `replSetGetStatus`
document and `write()` replaces it.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `refreshIntervalMS` | `10000` | How often the watcher refreshes stored topology |
| `clusterTopologyVariableName` | `__MONGODB_CLUSTER_TOPOLOGY` | Names where the topology document lives |

`clusterTopologyVariableName` is on the base rather than on any one plugin.
Every plugin has to name the location holding the document. Only the meaning of
that name changes: an environment variable for
[`plugin-local`](../local), and a parameter path, secret id, or cache key for
others.

Add your own keys by widening the config type:

```ts
interface MyConfig extends PluginConfig {
  region: string;
}

class MyPlugin extends ServerlessPlugin<MyConfig> {
  // base defaults still apply
}
```

## Writing a plugin

The driver validates plugins structurally. It checks that `setup`, `verify`,
`read`, and `write` are functions and that `name`, `version`, and `author` are
strings. It never uses `instanceof`.

So extending this class is optional. Any object of the right shape works, and
your plugin does not have to depend on this package at all. The base is here
for the config get/set plumbing and the defaults.

Structural checking is also the only thing that works reliably. `instanceof`
returns false across two copies of the same class, which happens whenever a
dependency tree holds two versions of this package. A plugin built against one
version would be rejected by a driver that resolved another.

## Exporting your plugin

The driver resolves a plugin from a package by checking a `default` export, a
`plugin` or `Plugin` export, then every other named export, so any of these
work:

```ts
export default class MyPlugin extends ServerlessPlugin { /* ... */ }
export class MyPlugin extends ServerlessPlugin { /* ... */ }
export const plugin = new MyPlugin();
```

A class is constructed with no arguments. Configure it after construction with
`set()`, or give the class defaults of its own, since the driver passes nothing
to the constructor.
