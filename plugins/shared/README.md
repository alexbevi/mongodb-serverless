# Shared plugin contract

The abstract class and types every plugin in [`plugins/`](..) is built from.

**This is not a package.** There is no `package.json`, nothing to install, and
nothing published. It compiles into each plugin's own `dist` through that
plugin's `tsconfig.json`, so a plugin carries the contract with it and has no
runtime dependency to resolve.

That is deliberate. A published base would need its own version and release
whenever the contract changed, and every plugin would pin a version of it. Two
plugins pinning different versions puts two copies of the class in one
dependency tree, which is exactly the case where `instanceof` fails. The driver
validates structurally to survive that, which in turn means nothing needs the
class identity, which means there is no reason to publish it.

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

`get()` and `set()` throw `RangeError` on an unknown key, listing the keys that
do exist. Config is per instance, so two plugins never share state.

See [`../README.md`](..) for the default values and the reasoning behind them.

## Extending the config

```ts
interface MyConfig extends PluginConfig {
  region: string;
}

class MyPlugin extends ServerlessPlugin<MyConfig> {
  constructor() {
    super({ region: 'us-east-1' });   // base defaults still apply
  }
}
```

## Extending this class is optional

The driver checks a plugin by shape, so any object with the right members
works. The class is here for the config plumbing and the defaults. A plugin
that would rather implement the interface directly loses nothing.
