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
so the topology is as fresh as whatever last exported it, and nothing refreshes
it while your process runs. Deployments that need current topology want a
shared store and the watcher.

`replSetGetStatus` describes a replica set, so sharded and load-balanced
clusters are out of scope.
