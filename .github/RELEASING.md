# Releasing

## Existing packages

Add a changeset with the change it describes:

```sh
pnpm changeset
```

Merging to `main` opens a "Version Packages" PR. Merging that PR publishes to
npm and creates the GitHub Releases after CI passes.

The watcher is private and ignored by Changesets. Remove both restrictions
when it is ready to publish.

## First publish of a new package

Add the package to `pnpm-workspace.yaml` and the root TypeScript build
references. Set a release version, ensure it is neither private nor ignored by
Changesets, and verify that its `npm pack` tarball installs.

Replace `example` with the plugin's directory and package suffix:

```sh
package_dir=plugins/example
package_name=@mongodb-serverless/plugin-example
npm login
pnpm build
( cd "$package_dir" && npm publish --access public )
npm view "$package_name" version
```

Complete npm's 2FA prompt. An authenticator code can be supplied with `--otp`;
passkeys and security keys use browser authentication. Wait for the package to
appear in `npm view` before configuring trust.

Each package needs its own trusted publisher. Use npm 11.15 or later with
package write access:

```sh
npm trust github "$package_name" \
  --repo alexbevi/mongodb-serverless --file release.yml --allow-publish
npm trust list "$package_name"
```

This authorizes `.github/workflows/release.yml` to publish directly. The
workflow already requests `id-token: write` and publishes without `NPM_TOKEN`.
After a successful CI publish, delete any old repository token secret and
revoke its npm token.

See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
for setup through the npm website.

## Repository setup

Allow GitHub Actions to open version PRs:

```sh
gh api --method PUT repos/alexbevi/mongodb-serverless/actions/permissions/workflow \
  -F default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true
```

Keep the pnpm versions in `ci.yml` and `release.yml` aligned.
