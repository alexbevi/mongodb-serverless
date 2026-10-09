# Anti-slop source

Source: https://github.com/dmmulroy/anti-slop

Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`

Copied from `skills/install-anti-slop/assets/anti-slop/` to
`tools/oxlint/anti-slop/` using the installed skill's `scripts/install.mjs`.
The copied assets match that commit byte for byte. This provenance file is the
only addition. The nested Stylistic license and provenance remain intact.

The generic plugin is registered in `.oxlintrc.json` through
`../anti-slop.mjs`, which uses `tsx` to load TypeScript on Node 20.19.
The Effect plugin is
included but disabled because this workspace does not depend on Effect.

Run `pnpm lint` from the repository root. All generic anti-slop rules and
`oxc/no-accumulating-spread` are errors. Installed agent assets, the vendored
plugin, and generated `dist` directories are excluded. Existing source findings
require review. This installation does not migrate application code.

Keep `oxlint` and `@oxlint/plugins` pinned to the same version when upgrading.

Run `node --test tools/oxlint/anti-slop.test.mjs` to verify the configured plugin
rejects an unknown parameter and accepts a concrete parameter. The test runs
Oxlint with the current Node executable so it also checks loader compatibility.
