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

### Trusted publishing, preferred

With this configured there is no token to store, leak, or rotate, and npm
records provenance automatically for public repos.

On npmjs.com, for each of `@mongodb-serverless/driver` and
`@mongodb-serverless/plugin-local`, open the package settings and add a trusted
publisher:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Repository owner | `alexbevi` |
| Repository | `mongodb-serverless` |
| Workflow filename | `release.yml` |

The release workflow already requests `id-token: write`, so nothing else
changes. npm 11.5.1 or later is required, which the workflow installs.

A package must exist before it can be given a trusted publisher, so the very
first publish of each package needs a token.

### Token, for the first publish and as a fallback

Create a granular access token on npmjs.com with read and write access to the
`@mongodb-serverless` scope, and set it as the `NPM_TOKEN` repository secret.

Set an expiry you are willing to track yourself, and put a calendar reminder
somewhere other than this repo. **npm does not expose a token's expiry date**:
`npm token list` reports `created` but no expiry, and granular tokens do not
appear there at all. Nothing in CI can warn you before it lapses.

Once trusted publishing is configured for both packages, delete the secret.

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
