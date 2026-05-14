# PostHog MCP

TypeScript SDK for instrumenting Model Context Protocol servers with PostHog analytics.

> Warning:
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

Use `intentFallback` when you want a fallback for clients that call tools without the `context` argument.
This is a consumer-supplied callback — the SDK does no inference of its own; whatever string you return becomes `$mcp_intent`.
The explicit `context` argument always wins; fallback values are marked with `$mcp_intent_source = "inferred"`.

```ts
track(server, {
  apiKey: process.env.POSTHOG_API_KEY,
  context: true,
  intentFallback: (request) => {
    const toolName = request.params?.name;
    return toolName ? `Calling ${toolName}` : undefined;
  },
});
```

With `enableAITracing: true`, tool calls also emit `$ai_span` events with `$ai_trace_id` and `$ai_span_id`.
The regular `mcp_tool_call` event includes the same trace/span IDs so it can be joined back to the LLM analytics span.

### Conversation ID (opt-in)

When `enableConversationId: true` is passed to `track()`, the SDK injects an optional `conversation_id` argument into every tool's input schema and tells the agent to reuse the value the server returns. When the agent omits it on a call, the SDK mints a UUID and appends a short text block to the tool's response asking the agent to echo the same `conversation_id` on subsequent calls. The value the agent supplies (or the SDK mints) is captured on PostHog events as `$mcp_conversation_id` — separate from `$session_id`, which is unchanged. Off by default.

```ts
track(server, {
  apiKey: process.env.POSTHOG_API_KEY,
  enableConversationId: true,
});
```

**Caveats:**

- The prompt-back is appended as a regular `text` content block (the only channel MCP currently offers for server→agent communication). Consumers that surface raw tool-call content to end users will see `[SERVER]: Reuse conversation_id=…` in their UI. If/when the MCP spec grows a server-directives channel (e.g. on `_meta`), the SDK will move there.
- The captured `$mcp_conversation_id` value is agent-controlled when the agent supplies one — the SDK accepts any non-empty string. Customers wanting to bind it to their own session scheme (chat ID, JWT `jti`, request ID) can do so freely; the trade-off is that nothing prevents a misbehaving agent from sending arbitrary values.

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

## Event schema

The SDK emits PostHog events using a stable MCP-specific schema.
The package exports `PostHogMCPAnalyticsEvent`, `PostHogMCPAnalyticsProperty`, and `POSTHOG_MCP_ANALYTICS_SOURCE` constants so product code can query the same contract without hard-coded strings.

Canonical event names:

- `mcp_tool_call` for each MCP tool call
- `mcp_tools_list` when clients list available tools
- `mcp_initialize` when clients initialize a session
- `$ai_span` for tool-call spans when `enableAITracing: true`
- `$exception` for captured tool errors

Important properties:

- `$mcp_source = "posthog_mcp_analytics"`
- `$mcp_intent` from the `context` argument, or from `intentFallback` when no context was provided
- `$mcp_intent_source` as `context_parameter` or `inferred`
- `$mcp_tool_name` and `$mcp_resource_name`
- `$mcp_tool_description`, the tool's current `description` at the moment of the call — populated on `mcp_tool_call` and on the paired `$exception` event so the description is visible inline while triaging
- `$mcp_listed_tool_names`, the array of tool names advertised in a `tools/list` response — populated on `mcp_tools_list` events so you can correlate "tools the agent was offered" with "tools the agent actually called" (e.g. find advertised tools that never get picked)
- `$mcp_parameters` and `$mcp_response`, after redaction and truncation
- `$mcp_duration_ms`
- `$mcp_is_error`
- `$session_id`
- `$ai_trace_id`, `$ai_span_id`, and `$ai_session_id` when AI tracing is enabled

The SDK does not emit `$mcp_context`.
Use `$mcp_intent` for agent/user intent.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full architecture, property catalog, sample queries, and migration notes vs the upstream mcpcat schema.

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

## Releases

Releases are semi-automatic through Changesets and GitHub Actions.
See [RELEASE.md](./RELEASE.md) for the release process.

Release approval requests are posted in Slack to `#approvals-client-libraries`.

## Attribution

This SDK started from a duplicated copy of the MIT-licensed [MCPcat TypeScript SDK](https://github.com/MCPCat/mcpcat-typescript-sdk). We are grateful for their work on MCP server instrumentation patterns, especially tool-call tracing, context capture, and MCP SDK compatibility handling.
