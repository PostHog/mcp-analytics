# PostHog MCP analytics

TypeScript SDK for instrumenting Model Context Protocol servers with PostHog analytics.

This package is in early development. The initial goal is to help MCP server owners understand tool usage, agent intent, client/session metadata, errors, and feedback without hand-rolling MCP-specific analytics.

## Install

```bash
pnpm add @posthog/mcp-analytics
```

## Usage

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { track } from "@posthog/mcp-analytics";

const server = new Server({ name: "my-mcp-server", version: "1.0.0" });

track(server, {
  apiKey: process.env.POSTHOG_API_KEY,
  context: true,
  host: "https://us.i.posthog.com",
});
```

With `context: true`, the SDK adds a required `context` argument to every tool call, strips it before invoking your handler, and captures it as `$mcp_context` and `$mcp_user_intent` on PostHog events.

The SDK sends events through `posthog-node`, so it uses the same PostHog ingestion client, batching, retry, flush, and shutdown behavior as the existing Node SDK.

If your application already owns a PostHog client, pass it in instead:

```ts
import { PostHog } from "posthog-node";
import { track } from "@posthog/mcp-analytics";

const posthog = new PostHog(process.env.POSTHOG_API_KEY ?? "");

track(server, {
  posthogClient: posthog,
});
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
pnpm fix
```

`pnpm typecheck` uses the TypeScript 7 native preview via `tsgo`.

## Status

This SDK is not ready for public customer use yet. The current repository starts from a proven MCP instrumentation implementation while we replace the product-specific ingestion, API surface, naming, and documentation with PostHog-owned equivalents.

## Attribution

This SDK started from a duplicated copy of the MIT-licensed [MCPcat TypeScript SDK](https://github.com/MCPCat/mcpcat-typescript-sdk). We are grateful for their work on MCP server instrumentation patterns, especially tool-call tracing, context capture, and MCP SDK compatibility handling.
