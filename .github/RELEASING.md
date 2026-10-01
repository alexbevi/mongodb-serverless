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
`@mongodb-serverless` scope, then set:

| Kind | Name | Value |
|---|---|---|
| Secret | `NPM_TOKEN` | The token |
| Variable | `NPM_TOKEN_EXPIRES` | Its expiry, as `YYYY-MM-DD` |

The variable exists because **npm does not expose a token's expiry date**.
`npm token list` reports `created` but no expiry, and granular tokens do not
appear there at all. The date has to be recorded by hand when the token is
made, or the 15-day warning has nothing to measure against.

Once trusted publishing is configured for both packages, delete the secret and
the variable. The health check then reports nothing to watch.

## The health check

`npm-token-health.yml` runs weekly and on demand. It:

- confirms the token still authenticates, against `GET /-/whoami`
- works out the days remaining from `NPM_TOKEN_EXPIRES`
- warns at 15 days or fewer, and opens or updates an issue assigned to the
  repository owner

The issue is the part that reaches a human. A `::warning::` annotation only
shows in the Actions UI and emails nobody; GitHub does email on issue
assignment, and on a scheduled workflow failing, which is why a rejected token
also fails the job.

A registry outage reports `unknown` rather than warning, so an npm incident
does not look like an expiring token.
