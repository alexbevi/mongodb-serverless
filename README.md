# MongoDB Serverless Driver

A wrapper around the [MongoDB Node.js driver](https://github.com/mongodb/node-mongodb-native)
that skips topology discovery on connect.

In a serverless runtime, every cold start pays for the driver's normal startup
work: handshake each replica set member, elect a view of the topology, then
select a server. The instance serves one request and throws that away. This
wrapper moves discovery out of the request path. A watcher process keeps the
output of `replSetGetStatus` in a store, a plugin reads it, and the driver
opens a `directConnection` straight to the member it needs.

Reads go to a secondary, writes go to the primary, each on its own client,
created on first use.

## Components

| Directory | Package | What it does |
|---|---|---|
| `driver/` | `@mongodb-serverless/driver` | Replaces `MongoClient` and routes operations to a read or write client |
| `watcher/` | `@mongodb-serverless/watcher` | Polls a cluster and writes its topology through a plugin |
| `plugins/shared/` | not published | The plugin contract, compiled into each plugin |
| `plugins/local/` | `@mongodb-serverless/plugin-local` | Reads topology from an environment variable |

## Quickstart

Change the import, pick a plugin, and leave the rest of your code alone.

```ts
import { MongoClient } from '@mongodb-serverless/driver';
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

const client = new MongoClient(uri, { plugin: new LocalPlugin() });

await client.db('app').collection('users').insertOne({ n: 1 }); // primary
await client.db('app').collection('users').find({}).toArray();  // secondary
```

Every other export (`ObjectId`, `ReadPreference`, the error classes) passes
through to the real driver unchanged.

The topology comes from the watcher, which runs separately:

```ts
import { Watcher } from '@mongodb-serverless/watcher';
import { LocalPlugin } from '@mongodb-serverless/plugin-local';

const watcher = new Watcher({ uri, plugin: new LocalPlugin({ writable: true }) });
watcher.start();
```

The driver's plugin is read-only; only the watcher's is writable. For a
one-off local setup you can also populate the variable by hand:

```sh
export __MONGODB_CLUSTER_TOPOLOGY="$(mongosh --quiet --eval 'JSON.stringify(rs.status())')"
```

## Scope

v1 supports replica sets only. Sharded and load-balanced clusters report
topology through commands other than `replSetGetStatus`, so they need a
different source. Change streams and sessions that span the read and write
client are also unsupported. See `driver/README.md` for the details and the
reasoning.

A failover is only picked up on the watcher's next cycle. Until then the stored
topology names a member that is no longer primary and writes will fail, so
`refreshIntervalMS` is a tradeoff rather than a fix.

## Development

```sh
pnpm install
pnpm test              # everything, including the real cluster
pnpm test:unit         # no Docker, no build, for a fast loop
pnpm test:integration  # just the cluster suite
pnpm typecheck
```

The integration suite runs against a real 3-node replica set that
`test/harness/cluster.ts` starts in Docker on demand and reuses across
runs. Without Docker it skips. `pnpm cluster:stop` removes the container; the
next run rebuilds it in about 30 seconds.

Run `npm run benchmark` for cold connection timings against a TLS replica set with
simulated availability-zone latency. See the [benchmark usage](benchmark/README.md)
and the recorded [baseline](BASELINE.md).

Requires Node 20.19 or later. See `AGENTS.md` for the working agreement and
[`.github/RELEASING.md`](.github/RELEASING.md) for how releases work.

## Releasing

Add a changeset with your change:

```sh
pnpm changeset
```

Merging to `main` opens a version PR; merging that publishes and creates the
GitHub Releases.

### First release of a new plugin

Each package needs its own trusted publisher on npm. Configure it after the
package's first manual publish so later releases can run through GitHub Actions
without an npm token.

Add the plugin to `pnpm-workspace.yaml` and the root TypeScript build references.
Give it a release version, ensure it is not private or ignored by Changesets,
and verify an `npm pack` tarball installs before publishing.

From the repository root, replace `example` with your plugin's directory suffix
and package suffix, such as `local` for `plugins/local` and
`@mongodb-serverless/plugin-local`:

```sh
plugin_name=example
npm login
pnpm build
( cd "plugins/$plugin_name" && npm publish --access public )
```

Complete npm's 2FA prompt. If you use an authenticator app, you can supply its
current code with `--otp=YOUR_CODE`. A passkey or security key uses browser
authentication instead.

Publishing can succeed before npm makes the package available while its scan
runs. Confirm availability before configuring trust:

```sh
npm view "@mongodb-serverless/plugin-$plugin_name" version
```

Then authorize the release workflow and verify the configuration:

```sh
npm trust github "@mongodb-serverless/plugin-$plugin_name" \
  --repo alexbevi/mongodb-serverless \
  --file release.yml \
  --allow-publish

npm trust list "@mongodb-serverless/plugin-$plugin_name"
```

`npm trust` requires npm 11.15.0 or later, package write access, and account 2FA.
Complete any authentication prompts.

Alternatively, open the package's npm **Settings > Trusted Publisher > GitHub
Actions** and enter:

| Field | Value |
|---|---|
| Organization or user | `alexbevi` |
| Repository | `mongodb-serverless` |
| Workflow filename | `release.yml` |
| Environment | Leave blank |
| Allowed actions | Enable direct publishing with `npm publish` |

Use the filename alone, not `.github/workflows/release.yml`. Repeat this setup
for every new package; trust is not shared across the npm scope. The existing
release workflow already requests `id-token: write`.

See [npm's trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/)
and [the release guide](.github/RELEASING.md) for repository setup and token cleanup.
