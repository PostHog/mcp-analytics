# Releasing @posthog/mcp

This repository uses Changesets and a GitHub Actions release workflow, following the same broad process as the PostHog JavaScript SDKs.

## Release trigger

This repository uses Changesets for versioning.
The current workflow releases from pending changesets merged to `main`; it does not require the `release` label to trigger.

The release workflow runs when a commit lands on `main` with a change under `.changeset/**`.
It can also be started manually from GitHub Actions.

If there are pending changeset files under `.changeset/*.md` other than `.changeset/README.md`, the workflow versions the package before publishing.
If there are no pending changesets, the manual workflow can still publish the current `package.json` version when that version is not on npm yet.
This lets maintainers retry a release after a publish-time failure without creating an artificial version bump.

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

## Verifying pending changes

You can verify a pending release locally with:

```bash
pnpm exec changeset status --verbose
```

## Approval and publishing

After a release-triggering PR is merged:

1. GitHub Actions runs the `Release` workflow on `main`.
2. The workflow checks for pending changesets.
3. The workflow posts a Slack approval request using PostHog's shared client-libraries approval workflow.
4. A maintainer approves the `NPM Release` GitHub environment.
5. If changesets are present, the workflow runs `pnpm bump` and updates the lockfile.
6. The workflow commits the version bump with the repository release GitHub App.
7. The workflow publishes to npm with public access.
8. npm runs `prepublishOnly`, which runs `pnpm verify`, immediately before publishing.
9. The workflow tags the repository, creates a GitHub release, and posts a Slack release confirmation.

The package is published publicly as `@posthog/mcp`.

The workflow uses npm trusted publishing through GitHub Actions OIDC and publishes npm provenance.

## Retrying a failed publish

If the workflow pushed the version-bump commit to `main` but failed during `npm publish`, fix the publishing configuration and manually run the `Release` workflow again.
The workflow will detect that the current `package.json` version is not on npm and publish it without requiring a new changeset.

## Required GitHub configuration

The release workflow depends on the same shared release infrastructure used by the PostHog JavaScript SDKs.

Repository or organization variables:

- `SLACK_APPROVALS_CLIENT_LIBRARIES_CHANNEL_ID`
- `GROUP_CLIENT_LIBRARIES_SLACK_GROUP_ID`

Repository or organization secrets:

- `SLACK_CLIENT_LIBRARIES_BOT_TOKEN`
- `POSTHOG_PROJECT_API_KEY`

`NPM Release` environment secrets:

- `GH_APP_POSTHOG_MCP_RELEASER_APP_ID`
- `GH_APP_POSTHOG_MCP_RELEASER_PRIVATE_KEY`

The `NPM Release` environment should require approval from the client libraries maintainers.
Create a dedicated GitHub App for this repository, install it only on `PostHog/mcp-analytics`, and grant it `Contents: Read and write`.
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

The package keeps `prepublishOnly` as the final publish safety gate, matching the PostHog JavaScript SDK release pattern.
