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

### Trusted publishing

CI publishes with no stored credential. pnpm 12 exchanges the workflow's OIDC
token for a short-lived npm one, and the release job already requests
`id-token: write`.

Both workflows select pnpm 12.8.1 explicitly. Keep those versions aligned when
upgrading the release tooling.

Each package needs a trusted publisher on npm, which can only be added to a
package that already exists. So the first publish of a new package is manual:

```sh
npm login
pnpm build
( cd driver        && npm publish --access public --otp=CODE )
( cd plugins/local && npm publish --access public --otp=CODE )
```

`--otp` satisfies the account's 2FA requirement directly. Do not create a
token with 2FA bypass for this; npm has announced restrictions on those, and
trusted publishing removes the need.

Then register the publisher for each package:

```sh
npm trust github @mongodb-serverless/driver \
  --repo alexbevi/mongodb-serverless --file release.yml --allow-publish
npm trust github @mongodb-serverless/plugin-local \
  --repo alexbevi/mongodb-serverless --file release.yml --allow-publish
```

Check it with `npm trust list @mongodb-serverless/driver`. After that, merging
a version PR publishes with no secret involved, and npm records provenance.

## No token to monitor

The release workflow no longer reads `NPM_TOKEN`. After verifying a trusted
publish, delete any old repository secret and revoke its npm token. The
token-health workflow is no longer needed.

If a token is ever reintroduced, note that **npm does not expose a token's
expiry date**: `npm token list` reports `created` but no expiry, and granular
tokens do not appear there at all. Validity can be checked against
`GET /-/whoami`; remaining lifetime cannot.
