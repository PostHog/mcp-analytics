# PostHog MCP

TypeScript SDK for instrumenting Model Context Protocol servers with PostHog analytics.

> [!WARNING]
> This package is in very early access and is not suitable for production use yet.
> The API, event names, PostHog property schema, tracing behavior, and release process may change without notice while we dogfood the SDK.
> We publish in public because PostHog builds in public, but you should treat `0.0.x` releases as experimental.

The initial goal is to help MCP server owners understand tool usage, agent intent, client/session metadata, errors, and feedback without hand-rolling MCP-specific analytics.

## Install

```bash
pnpm add @posthog/mcp
```

## Usage

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { track } from "@posthog/mcp";

const server = new Server({ name: "my-mcp-server", version: "1.0.0" });

track(server, {
  apiKey: process.env.POSTHOG_API_KEY,
  context: true,
  enableAITracing: true,
  host: "https://us.i.posthog.com",
});
```

With `context: true`, the SDK adds a required `context` argument to every tool call, strips it before invoking your handler, and captures it as `$mcp_intent` on PostHog events.
Captured tool parameters omit the duplicated `context` value and MCP transport internals.

With `enableAITracing: true`, tool calls also emit `$ai_span` events with `$ai_trace_id` and `$ai_span_id`.
The regular `mcp_tool_call` event includes the same trace/span IDs so it can be joined back to the LLM analytics span.

The SDK sends events through `posthog-node`, so it uses the same PostHog ingestion client, batching, retry, flush, and shutdown behavior as the existing Node SDK.

If your application already owns a PostHog client, pass it in instead:

```ts
import { PostHog } from "posthog-node";
import { track } from "@posthog/mcp";

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

## Attribution

This SDK started from a duplicated copy of the MIT-licensed [MCPcat TypeScript SDK](https://github.com/MCPCat/mcpcat-typescript-sdk). We are grateful for their work on MCP server instrumentation patterns, especially tool-call tracing, context capture, and MCP SDK compatibility handling.
