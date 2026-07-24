# Releasing Agentix

Agentix publishes five public npm packages as one fixed, pre-1.0 version:

- `@agentix/core`
- `@agentix/compiler`
- `@agentix/cli`
- `@agentix/testing`
- `@agentix/adapters-http`

Examples, sandboxes, benchmarks, and the repository root remain private. The
unscoped `agentix` npm name belongs to an unrelated project and is not a release
target.

## GitHub test packages

Public GitHub Packages npm artifacts require authentication even when the
package is public. For frictionless testing, Agentix instead publishes immutable
package tarballs as GitHub prerelease assets. They keep the canonical
`@agentix/*` names and can be installed directly from HTTPS release URLs without
a registry token.

Run the `Publish GitHub test packages` workflow manually, or push an immutable
tag named `github-test-v<prerelease-version>`. The workflow applies the same
build, tarball, test, and frozen-corpus gates as an npm release. Its release
notes contain copy-paste `npm install` commands for that exact source revision.
For example:

```sh
npm install \
  https://github.com/pewpewgogo/agentix/releases/download/<tag>/<core-tarball> \
  https://github.com/pewpewgogo/agentix/releases/download/<tag>/<http-tarball>
```

Test-release versions are immutable prereleases such as
`0.1.0-github.42.a1b2c3d`. They do not create npm registry versions, GitHub
Packages entries, or compatibility promises.

## Normal release flow

1. Add a changeset with `npm exec -- changeset` and select the public packages
   affected by the change. The fixed group keeps their final versions equal.
2. Open and merge the normal feature pull request after CI passes.
3. The `Release Agentix packages` workflow verifies the exact `main` revision,
   then creates or updates a release pull request containing package versions,
   internal dependency ranges, changelogs, and the lockfile.
4. Review and merge the release pull request. The same workflow repeats the
   build, typecheck, tests, and frozen-corpus check, then publishes every new
   package version to npm with provenance.

Do not edit package versions, changelogs, or the release pull request's generated
lockfile changes by hand. `npm run release:status` previews pending releases.

## npm authentication

The release job grants `id-token: write` for npm trusted publishing and also
accepts a repository secret named `NPM_TOKEN` for bootstrap or fallback use.

Before the first release:

1. create or confirm ownership of the `@agentix` npm organization;
2. add a granular automation token as the `NPM_TOKEN` GitHub Actions secret;
3. merge the generated initial release pull request and confirm all five
   packages publish at the same version; and
4. configure each npm package's trusted publisher as repository
   `pewpewgogo/agentix` with workflow file `.github/workflows/release.yml`.

After trusted publishing succeeds for every package, remove `NPM_TOKEN` so npm
publishing relies only on short-lived GitHub OIDC credentials. Keep npm
two-factor authentication enabled for human account operations.

## Release gates and recovery

The workflow will not publish unless these commands pass on a clean runner:

```sh
npm ci
npm run build
npm run verify
npm run benchmark:corpus:check
```

An npm version is immutable. If only some packages publish, do not reuse or
overwrite that version. Fix the cause, add a patch changeset, and release the
whole fixed group at the next version. Never change the frozen v1 corpus hashes
to make a release pass.
