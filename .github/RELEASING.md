# Releasing

## Day to day

Add a changeset in the same commit as the change it describes:

```sh
pnpm changeset
```

On merge to `main`, the release workflow opens a "Version Packages" PR that
applies every pending changeset. Merging that PR publishes to npm and creates
the GitHub Releases.

`@mongodb-serverless/watcher` is `private: true`, so it is not published. The
`ignore` list in `.changeset/config.json` keeps it out of version PRs; remove
it from both when the watcher is ready to ship.

## One-time setup

### Let Actions open the version PR

Changesets pushes a `changeset-release/main` branch and opens a PR from it.
GitHub blocks that by default, with *"GitHub Actions is not permitted to
create or approve pull requests"*, so enable it once:

```sh
gh api --method PUT repos/alexbevi/mongodb-serverless/actions/permissions/workflow \
  -F default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true
```

Or tick **Settings > Actions > General > Workflow permissions > Allow GitHub
Actions to create and approve pull requests**.

Without it the release job fails *after* pushing the branch, so the PR can
still be opened by hand from the link in the log.

### Why a token is required

Changesets publishes through `pnpm publish`, because `pnpm-workspace.yaml`
makes this a pnpm workspace and that choice is not configurable.

**`pnpm publish` has no trusted-publishing support** and no `--provenance`
flag, so npm's OIDC flow is unavailable here and a stored token is the only
option. Attempting it also breaks the publish outright: `pnpm publish` passes
`--no-git-checks`, which it delegates to npm, and current npm rejects the
unknown flag with `EUNKNOWNCONFIG`.

Moving to trusted publishing would mean publishing with `npm publish` instead,
which means not using Changesets' publish step.

<details>
<summary>What trusted publishing would give up in exchange</summary>

No stored token to leak or rotate, and automatic provenance attestation. Worth
revisiting if pnpm gains OIDC support, or if the release step is rewritten to
call `npm publish` per package directly.

</details>


### Setting the token

Create a **granular access token** on npmjs.com with:

- read and write access to the `@mongodb-serverless` scope
- **2FA bypass enabled**

Both matter. Without the bypass the registry accepts the token and then
refuses the publish with `E403: Two-factor authentication or granular access
token with bypass 2fa enabled is required to publish packages`, because the
account requires 2FA for writes and CI cannot answer a prompt.

Set it as the `NPM_TOKEN` repository secret, piping the value in so it stays
out of your shell history:

```sh
pbpaste | gh secret set NPM_TOKEN
```

`gh secret set NPM_TOKEN` on its own reads EOF from a non-interactive stdin
and silently stores an empty value, which shows up later as `ENEEDAUTH`.

Set an expiry you are willing to track yourself, and put a calendar reminder
somewhere other than this repo. **npm does not expose a token's expiry date**:
`npm token list` reports `created` but no expiry, and granular tokens do not
appear there at all. Nothing in CI can warn you before it lapses.

## The health check

`npm-token-health.yml` runs weekly and on demand. It checks the token still
authenticates, against `GET /-/whoami`, and fails the run if the registry
rejects it. GitHub emails the repository owner when a scheduled workflow fails.

That is all it can do. Checking validity catches a token that has already
lapsed or been revoked; it cannot see one about to. A registry outage reports
`unknown` rather than failing, so an npm incident does not look like a dead
token.

With no `NPM_TOKEN` set the check reports that there is nothing to watch, which
is the expected state once trusted publishing is in place.
