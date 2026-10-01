# Changesets

Version bumps and changelogs for the published packages.

Add one in the same commit as the change it describes:

```sh
pnpm changeset
```

Pick the packages affected, pick patch/minor/major, and write a line a consumer
would want to read. The file it creates belongs in the commit.

On merge to `main`, a workflow opens a "Version Packages" PR that applies every
pending changeset. Merging that PR publishes to npm and creates the GitHub
Releases.

`@mongodb-serverless/watcher` is ignored while it is private.
