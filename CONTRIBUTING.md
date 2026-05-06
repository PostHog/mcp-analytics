# Contributing

This repository contains the TypeScript SDK for PostHog MCP instrumentation.

## Setup

```bash
pnpm install
```

## Development

Run the full local gate before opening a PR:

```bash
pnpm verify
```

Individual commands:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm typecheck:tsc6
pnpm check
pnpm fix
```

## Commits

Use conventional commits:

```text
<type>: <description>
```

Examples:

```bash
git commit -m "feat: add posthog capture transport"
git commit -m "fix: strip analytics context before tool handlers"
git commit -m "chore: update sdk build tooling"
```

## Code Quality

The pre-push hook runs `pnpm verify`.

`pnpm typecheck` uses the TypeScript 7 native preview through `tsgo`. `pnpm typecheck:tsc6` remains available as a compatibility check for tooling that still uses the TypeScript package API.
