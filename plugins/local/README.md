# @mongodb-serverless/plugin-local

Reads cluster topology from an environment variable. The first plugin for
[`@mongodb-serverless/driver`](../../driver), and the one to use for local
development.

## Install

```sh
npm install @mongodb-serverless/plugin-local
```

## Usage

```ts
import { MongoClient } from '@mongodb-serverless/driver';
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

const client = new MongoClient(uri, { plugin: new LocalPlugin() });
```

The variable holds the JSON output of
[`replSetGetStatus`](https://www.mongodb.com/docs/manual/reference/command/replSetGetStatus/),
which is what `rs.status()` returns:

```sh
export __MONGODB_CLUSTER_TOPOLOGY="$(mongosh --quiet --eval 'JSON.stringify(rs.status())')"
```

`verify()` throws if the variable is unset or does not parse as JSON.

This plugin is read-only as constructed above, which is what the driver wants.
The watcher needs to write, so it asks:

```ts
new LocalPlugin({ writable: true });
```

A read-only `write()` throws `PluginReadOnlyError` and leaves the variable
untouched.

## Configuration

Override the variable name with the inherited `clusterTopologyVariableName`:

```ts
const plugin = new LocalPlugin();
plugin.set('clusterTopologyVariableName', 'MY_TOPOLOGY');
```

The default is `__MONGODB_CLUSTER_TOPOLOGY`. See
[the plugin overview](..) for the rest of the config.

## Scope

This plugin is for local and development use. It reads one process environment,
so a watcher in another process cannot update it. A deployment wants a plugin
backed by a store both processes can reach.

`replSetGetStatus` describes a replica set, so sharded and load-balanced
clusters are out of scope.
