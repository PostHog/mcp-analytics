# PostHog MCP analytics

TypeScript SDK for instrumenting Model Context Protocol servers with PostHog analytics.

This package is in early development. The initial goal is to help MCP server owners understand tool usage, agent intent, client/session metadata, errors, and feedback without hand-rolling MCP-specific telemetry.

## Install

```bash
pnpm add @posthog/mcp-analytics
```

## Development

```bash
pnpm install
pnpm verify
```

Useful commands:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm typecheck:tsc6
pnpm format
```

`pnpm typecheck` uses the TypeScript 7 native preview via `tsgo`.

## Status

This SDK is not ready for public customer use yet. The current repository starts from a proven MCP instrumentation implementation while we replace the product-specific ingestion, API surface, naming, and documentation with PostHog-owned equivalents.

## Attribution

This SDK started from a duplicated copy of the MIT-licensed [MCPcat TypeScript SDK](https://github.com/MCPCat/mcpcat-typescript-sdk). We are grateful for their work on MCP server instrumentation patterns, especially tool-call tracing, context capture, and MCP SDK compatibility handling.
