# Releasing @posthog/mcp

This repository uses Changesets and a GitHub Actions release workflow, following the same broad process as the PostHog JavaScript SDKs.

## Release trigger

Releases do not use a GitHub release label.

The release workflow runs when a commit lands on `main` with a change under `.changeset/**`.
It can also be started manually from GitHub Actions, but it still requires a pending changeset file.

If there are no changeset files under `.changeset/*.md` other than `.changeset/README.md`, the workflow skips publishing.

## Preparing a release

For every user-visible SDK change, add a changeset:

```bash
pnpm changeset
```

Choose the appropriate semver bump:

- `patch` for bug fixes and small compatible changes
- `minor` for new backwards-compatible SDK features
- `major` for breaking API, event schema, or behavior changes

Commit the generated `.changeset/*.md` file with the PR.

## First release

The initial package version is checked in as `0.0.0`.
The first release PR includes a patch changeset, so the release workflow will version and publish `@posthog/mcp@0.0.1`.

You can verify the pending release locally with:

```bash
pnpm exec changeset status --verbose
```

## Approval and publishing

After a release-triggering PR is merged:

1. GitHub Actions runs the `Release` workflow on `main`.
2. The workflow checks for pending changesets.
3. The workflow posts a Slack approval request using PostHog's shared client-libraries approval workflow.
4. A maintainer approves the `NPM Release` GitHub environment.
5. The workflow runs `pnpm verify`.
6. The workflow runs `pnpm bump` and updates the lockfile.
7. The workflow verifies the versioned package again.
8. The workflow publishes to npm with public access and npm provenance.
9. The workflow tags the repository and creates a GitHub release.

The package is published publicly as `@posthog/mcp`.

## Required GitHub configuration

The release workflow depends on the same shared release infrastructure used by the PostHog JavaScript SDKs.

Repository or organization variables:

- `SLACK_APPROVALS_CLIENT_LIBRARIES_CHANNEL_ID`
- `GROUP_CLIENT_LIBRARIES_SLACK_GROUP_ID`

Repository or organization secrets:

- `SLACK_CLIENT_LIBRARIES_BOT_TOKEN`
- `POSTHOG_PROJECT_API_KEY`

`NPM Release` environment secrets:

- `GH_APP_POSTHOG_JS_RELEASER_APP_ID`
- `GH_APP_POSTHOG_JS_RELEASER_PRIVATE_KEY`

The `NPM Release` environment should require approval from the client libraries maintainers.
The release GitHub App must be allowed to push the version-bump commit to `main`, matching the PostHog JavaScript SDK release setup.

## Local checks

Before merging release-related changes, run:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Or run the full verification pipeline:

```bash
pnpm verify
```
