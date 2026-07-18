# Contributing

## Commit format

This repository uses Conventional Commits. Release Please reads commits on `main` and determines the next package version from them.

Use one of these forms for user-facing changes:

```text
fix: correct stale worktree index cleanup
feat: add a CodeGraph query command
feat!: change the project routing contract
```

Scopes are optional:

```text
fix(mcp): cancel timed-out worker requests
feat(pi): render compact CodeGraph results
```

## Version rules

| Commit | Version change | Example |
| --- | --- | --- |
| `fix:` | Patch | `0.2.0` to `0.2.1` |
| `feat:` | Minor | `0.2.0` to `0.3.0` |
| `type!:` | Major | `0.2.0` to `1.0.0` |
| `BREAKING CHANGE:` footer | Major | `0.2.0` to `1.0.0` |

`docs:`, `test:`, `ci:`, `chore:`, and other maintenance-only commits do not create a release by themselves. A breaking-change marker still takes precedence when a maintenance commit intentionally changes the public contract.

Do not manually change the version in `package.json` for a normal contribution. Do not manually edit generated release notes in `CHANGELOG.md` outside the release PR.

## Breaking changes

Use either `!` after the commit type or a `BREAKING CHANGE:` footer. The footer should explain the incompatible behavior and the required migration.

```text
feat(mcp)!: require trusted project roots

BREAKING CHANGE: projectPath values outside the configured workspace are now rejected. Add shared roots to allowedProjectRoots before upgrading.
```

## Release flow

1. Merge Conventional Commits into `main`.
2. Release Please creates or updates a release PR.
3. Review and merge the release PR.
4. The workflow updates `package.json` and `CHANGELOG.md` and creates a version tag and GitHub Release.
5. The same workflow publishes `@isac322/pi-codegraph` to npm through OIDC trusted publishing.
6. The Pi package gallery discovers the published npm version.

The release PR is the approval gate. Do not run `npm publish`, create release tags, or create GitHub Releases manually for normal releases.

## Release configuration

- Release workflow: `.github/workflows/publish.yml`
- Release Please configuration: `release-please-config.json`
- Current released version manifest: `.release-please-manifest.json`
- npm package: `@isac322/pi-codegraph`

The npm trusted publisher must remain bound to GitHub owner `isac322`, repository `pi-codegraph`, workflow filename `publish.yml`, and the `npm publish` action.
