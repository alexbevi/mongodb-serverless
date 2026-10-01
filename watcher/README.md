# @mongodb-serverless/watcher

Not implemented. This directory is a placeholder; there is no code here yet.

## Intended role

The watcher does the discovery work
[`@mongodb-serverless/driver`](../driver) refuses to do at connect time. It
runs outside the request path, holds a normal connection to the cluster, polls
`replSetGetStatus` every `refreshIntervalMS`, and writes the result back
through a plugin's `write()`.

Without it, stored topology is only as current as whatever last wrote it. That
works for local development with [`plugin-local`](../plugins/local), where you
export `rs.status()` yourself. It does not work for a deployment, where a
failover leaves every serverless instance pointed at a member that is no longer
primary.
