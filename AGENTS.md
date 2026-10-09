# Working agreement

## Tests come first

Write the test, run it, and confirm it fails for the reason you expect before
writing any implementation. A test that passes on first run was not testing the
thing you thought.

When a slice introduces several failing tests, make them pass one at a time,
one commit each. Do not batch them.

## Lint

Run `pnpm lint` to check project source with the vendored anti-slop Oxlint
rules. Configuration lives in `.oxlintrc.json`; source provenance and upgrade
notes live in `tools/oxlint/anti-slop/UPSTREAM.md`.

Report existing findings separately from new ones. Do not disable rules or
rewrite unrelated code to make an installation pass.

## Commits

Conventional commit format, imperative mood, no trailing period.

```
feat(driver): classify operations for routing
fix(plugin-local): throw when the topology variable is unset
docs: per-package READMEs
```

Scopes are `driver`, `watcher`, `plugins`, `plugin-local`, or omitted for
repo-wide changes.

Each commit is a self-contained unit: code, tests, and docs for one slice of
work. Commit to `main` and push. No feature branches unless asked.

## The driver never names a plugin

`driver/` must not depend on, import, or mention a specific plugin package, not
even as an optional peer dependency. Plugins arrive through configuration and
are validated structurally.

This is the rule most likely to erode, usually by importing `plugin-local` into
a test helper for convenience. A test enforces it. Adding a plugin must never
require a driver release.

## Validate plugins structurally, never with instanceof

`instanceof` returns false across two copies of the same class, which happens
whenever a dependency tree resolves two versions of a shared base. Check that
the required methods are functions instead.

## The plugin contract is not published

`plugins/shared/` has no `package.json` and is not a workspace package. It
compiles into each plugin's own `dist` through that plugin's `tsconfig.json`,
so a published plugin carries the contract and resolves nothing at runtime.

Keep it that way. A published base would need a version and a release of its
own, and two plugins pinning different versions is precisely the duplicate
class case that makes `instanceof` fail.

A plugin must also never carry a `workspace:*` dependency. That protocol is
pnpm-only, so the published tarball is uninstallable with npm and fails with
`EUNSUPPORTEDPROTOCOL`. Tests in `driver/test/workspace.test.ts` enforce both
rules, but verify a real install with `npm pack` before releasing.

## Writing

Apply the `unslop` skill to all prose: READMEs, commit messages, comments, docs.

READMEs state purpose, install, usage, and limitations. Nothing else. Do not
restate what the code already says, and do not explain a decision in a comment
when the code shows it.

Document limitations honestly, with the reason. A reader who hits
`SessionRoutingError` should find out why sessions cannot cross clients, not
just that they cannot.

## v1 scope

Replica sets only. No sharded clusters, no load-balanced clusters, no change
streams, no sessions spanning the read and write client. Keep these fences
explicit in the READMEs rather than letting them be discovered at runtime.

## Errors fail instanceof across packages

The contract compiles into each package, so the driver, the watcher, and a
plugin each hold their own copy of the shared error classes. `instanceof` is
false across that boundary even for the right error.

The `name` getter is stable across copies, so match on that. Keep it on every
new error class, and do not reach for `instanceof` in a cross-package test.

## Prefer the real cluster to a mocked client

Routing claims are asserted against a real replica set, reading `commandStarted`
events to see which member served each operation. An injected client factory
can only confirm that the code calls what the test told it to expect.

The gap is not theoretical. `initializeOrderedBulkOp` as the first operation on
a client threw "MongoClient must be connected" against a real server, because
the driver's bulk builders read connection state at construction and nothing
had called `connect()`. Every mocked test passed, because the fakes had no such
requirement. Mocks are still right for error paths and for topology shapes that
are awkward to produce on a live cluster, such as a stale document naming a
member that is gone.

When adding a fake client, give it the methods the real one needs, including
`connect()`. A fake that is easier to satisfy than the driver hides bugs.

The harness lives in `test/harness/` at the repo root, shared by both packages.
It hardcodes container names, so two copies would fight over one container.
`startCluster` gives a 3-node replica set; `startStandalone` gives a server
with no replica set, which a direct connection to one member cannot stand in
for because that still reports `setName`.

## Verify docs by running them

README examples are checked by running them against the built packages, not by
reading them. Resolving `plugin-local` by specifier was broken for every
release until an example was actually executed: the package exports only
`LocalPlugin`, and the resolver looked for `default`, `plugin`, or `Plugin`.
Tests passed throughout, because the fixtures used a default export.

When a README documents a mechanism, exercise that mechanism the way a user
would.

## Upgrading mongodb

The wrapper depends on driver internals that are verified, not guessed. The
export parity test pins the version it was checked against. On upgrade, re-run
it and re-verify:

- `directConnection` rejections (SRV, host count, `loadBalanced`)
- SRV turning TLS on by default
- which operations declare no `Aspect`, since the search index operations
  declare none and would misroute as reads
- `aggregate` detecting a write stage from the last pipeline stage only
- the set of public methods on `Collection` and `Db`, which the routing
  exhaustiveness test covers
