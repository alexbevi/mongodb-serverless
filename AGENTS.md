# Working agreement

## Tests come first

Write the test, run it, and confirm it fails for the reason you expect before
writing any implementation. A test that passes on first run was not testing the
thing you thought.

When a slice introduces several failing tests, make them pass one at a time,
one commit each. Do not batch them.

## Commits

Conventional commit format, imperative mood, no trailing period.

```
feat(driver): classify operations for routing
fix(plugin-local): throw when the topology variable is unset
docs: per-package READMEs
```

Scopes are `driver`, `watcher`, `plugin-base`, `plugin-local`, or omitted for
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
whenever a dependency tree resolves two versions of `plugin-base`. Check that
the required methods are functions instead.

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
