# @mongodb-serverless/watcher

Not implemented. This directory is a placeholder so the intended shape of the
monorepo is visible. There is no code here yet.

## Intended role

The watcher is the half of the system that does the discovery work
[`@mongodb-serverless/driver`](../driver) refuses to do at connect time. It
runs outside the request path, holds a normal connection to the cluster, polls
`replSetGetStatus` every `refreshIntervalMS`, and writes the result back
through a plugin's `write()`. The driver then reads that stored document
instead of discovering anything itself.

Without a watcher, the stored topology is only as current as whatever last
wrote it. That is fine for local development with
[`plugin-local`](../plugins/local), where you export `rs.status()` yourself.
It is not fine for a deployment, where a failover would leave every serverless
instance pointed at a member that is no longer primary.

## Open questions

Its design is a separate exercise. The unresolved parts are how it detects
failover faster than a fixed poll interval, whether one watcher serves many
clusters, how several watchers avoid writing conflicting topology to the same
store, and how the driver should behave when the stored document is stale
rather than wrong.
