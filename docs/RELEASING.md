# Releasing Agentix

Agentix publishes five public npm packages as one fixed, pre-1.0 version:

- `@agentixdev/core`
- `@agentixdev/compiler`
- `@agentixdev/cli`
- `@agentixdev/testing`
- `@agentixdev/adapters-http`

Examples, sandboxes, benchmarks, and the repository root remain private. The
unscoped `agentix` npm name belongs to an unrelated project and is not a release
target.

## GitHub test packages

Public GitHub Packages npm artifacts require authentication even when the
package is public. For frictionless testing, Agentix instead publishes immutable
package tarballs as GitHub prerelease assets. They keep the canonical
`@agentixdev/*` names and can be installed directly from HTTPS release URLs without
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
Packages entries, or compatibility promises. Package payloads contain only
runtime JavaScript, TypeScript declarations, package metadata, the package
README, and the MIT license. CI rejects source, tests, build caches, source maps,
and packages that exceed their declared file-count budget.

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

## npm authentication: trusted publishing only

Publishing authenticates exclusively through npm trusted publishing (GitHub
OIDC). No automation token exists at any point: the release job's
`id-token: write` permission lets npm (>= 11.5.1) mint a short-lived,
workflow-bound credential per publish, and provenance attestations are
generated automatically. The workflow deliberately sets no `registry-url` on
`actions/setup-node` — the `.npmrc` auth line it writes would mask OIDC
detection — and passes no npm secret to the changesets action.

npm cannot attach a trusted publisher to a name that has never been published,
so the five packages must exist once. Bootstrap, one time, from a maintainer's
local npm login session (browser + 2FA — still no token):

1. Create or confirm ownership of the `@agentixdev` npm organization.
2. `npm login`, then `node scripts/bootstrap-npm-packages.mjs` (add
   `--dry-run` to preview). It publishes a deprecated
   `0.0.0-bootstrap.0` placeholder for each missing name under the
   `bootstrap` dist-tag only, so nothing installs until a real release.
3. On npmjs.com, for EACH of the five packages: Settings → Trusted publisher →
   GitHub Actions, with organization `pewpewgogo`, repository `agentix`,
   workflow filename `release.yml` (filename only, not the path), no
   environment, and — required for configurations created after
   2026-05-20 — allowed action `npm publish`.
4. Merge the release pull request. The workflow publishes every package via
   OIDC with provenance; the `bootstrap` placeholders stay deprecated and
   `latest` points at the first real version.

Keep npm two-factor authentication enabled for human account operations, and
never add an `NPM_TOKEN` secret — a workflow that falls back to a long-lived
token silently re-creates the attack surface trusted publishing removes.

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
