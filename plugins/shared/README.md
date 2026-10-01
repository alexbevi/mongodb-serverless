# Shared plugin contract

The abstract class and types every plugin in [`plugins/`](..) is built from.

Not a package. It compiles into each plugin's own `dist` through that plugin's
`tsconfig.json`, so there is nothing to install and a plugin resolves nothing
at runtime.

## The contract

```ts
interface PluginConfig {
  refreshIntervalMS: number;
  clusterTopologyVariableName: string;
}

abstract class ServerlessPlugin<C extends PluginConfig = PluginConfig> {
  constructor(options?: { writable?: boolean } & Omit<C, keyof PluginConfig>);

  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly author: string;

  abstract setup(): Promise<void>;
  abstract verify(): Promise<void>;
  abstract read(): Promise<ReplSetGetStatus>;
  abstract write(status: ReplSetGetStatus): Promise<void>;

  get<K extends keyof C>(key: K): C[K];
  set<K extends keyof C>(key: K, value: C[K]): void;

  get writable(): boolean;
  protected assertWritable(): void;   // throws PluginReadOnlyError
}
```

`setup()` prepares the store. `verify()` throws if it is unusable, with a
message saying what is wrong. `read()` returns the stored `replSetGetStatus`
document and `write()` replaces it.

`get()` and `set()` throw `RangeError` on an unknown key, listing the keys that
do exist. Config is per instance, so two plugins never share state.

## Read-only by default

A plugin refuses to write unless constructed with `{ writable: true }`. Call
`assertWritable()` at the top of `write()`, before touching the store, so a
refused write changes nothing.

`set()` is allowed either way, since it configures the plugin rather than the
store. The driver constructs plugins plainly and only reads; the watcher asks
to write.

See [the plugin overview](..) for the default values.

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
works. This class only supplies the config plumbing and the defaults.
