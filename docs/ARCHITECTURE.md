# `@posthog/mcp` — Architecture

This document describes the internals of the `@posthog/mcp` SDK, the exact PostHog event/property contract it emits, and how the contract has diverged from the upstream mcpcat shape so existing PostHog dashboards can be migrated.

## TL;DR

- `track(server, options)` wraps an MCP server, intercepts request handlers, and pushes structured events through a small in-memory queue to PostHog via `posthog-node`.
- Every PostHog event uses `$mcp_*` prefixed properties so it never collides with PostHog autocapture, web analytics, or other product events.
- `$session_id` ties one MCP connection to one PostHog session. `distinct_id` falls back through `identified user → session id → "anonymous"`.
- Tool calls can additionally emit `$ai_span` for the PostHog LLM analytics UI and `$exception` whenever a tool errors.
- The schema has **changed multiple times** relative to mcpcat. The migration table at the bottom of this doc lists every renamed key.

---

## 1. Wire-up

The public surface in `src/index.ts` is two functions:

- `track(server, options)` — installs the SDK on an MCP server. Idempotent per server (re-calling logs and returns early).
- `publishCustomEvent(serverOrSessionId, eventData)` — emit an arbitrary event onto the same queue. Useful for product feedback signals.

`track()` does five things (`src/index.ts:138`):

1. Validate `server` is either a low-level `Server` or a high-level `McpServer`, and unwrap the latter to get the underlying `Server`.
2. Configure ingestion: read `options.host` or `POSTHOG_MCP_ANALYTICS_HOST` and stamp them onto the singleton `eventQueue`. If `options.posthogClient` is provided, that client is used directly; otherwise the SDK lazily creates a `posthog-node` client keyed by API key.
3. Build per-server tracking state (session id, identity cache, callbacks) stored in a module-level `WeakMap`.
4. Replace the `tools/call` and `initialize` handlers on the underlying `Server` instance with wrappers, and (for `McpServer`) install a `Proxy` on `_registeredTools` so any tool registered _after_ `track()` is also wrapped.
5. Optionally register the `get_more_tools` virtual tool when `options.reportMissing: true`.

Two implementations exist for historical reasons:

| Server type | File | Entry |
|---|---|---|
| Low-level `Server` (raw protocol SDK) | `src/modules/tracing.ts` | `setupToolCallTracing()` (`tracing.ts:259`) |
| High-level `McpServer` (typed wrapper) | `src/modules/tracing-v2.ts` | `setupTracking()` (`tracing-v2.ts:508`) |

Both converge on the same internal `UnredactedEvent` shape (`src/types.ts`) and the same publish pipeline.

## 2. Request lifecycle (tool call, high-level path)

```
client → MCP server → tools/call wrapper (tracing-v2.ts)
  ├─ initializeToolCallEvent      ← build UnredactedEvent, resolve session
  ├─ handleIdentify               ← fires posthog_identify only if identity changed
  ├─ applyResolvedMetadata        ← runs eventTags + eventProperties callbacks
  ├─ resolveToolCallIntent        ← context arg OR intentFallback callback
  ├─ originalHandler(request,extra)
  ├─ publishSuccessfulToolEvent   ← attaches result, duration
  └─ publishEvent(server, event)  → EventQueue
```

The wrapper strips the `context` argument from `params.arguments` before forwarding to the user's tool callback (`tracing-v2.ts:235`), so tool implementations never see the analytics-only arg.

## 3. Event pipeline

Once an `UnredactedEvent` is queued, `EventQueue.process()` (`src/modules/event-queue.ts:69`) runs it through:

1. **Customer redaction** — `redactEvent(event, redactionFn)` if `options.redactSensitiveInformation` was set (`src/modules/redaction.ts`). The redactor is called on every string in the event _except_ a protected field allowlist (`sessionId`, `id`, `apiKey`, `server`, identify-* fields, `resourceName`, `eventType`, `actorId`, `tags`, `properties`).
2. **Sanitization** — `sanitizeEvent` (`src/modules/sanitization.ts`):
   - `type: "image" | "audio"` content blocks → replaced with a text stub.
   - `type: "resource"` blocks with `.blob` → replaced.
   - Long base64-looking strings (≥10KB) → `"[binary data redacted...]"`.
   - Keys matching `SENSITIVE_KEY_PATTERN` (`authorization`, `cookie`, `password`, `token`, `secret`, `api_key`, `private_key`, …) → value replaced with `"[redacted]"`.
   - PostHog API-key patterns (`ph[a-z]_...`) in string values → `"[redacted]"`.
3. **Truncation** — `truncateEvent` (`src/modules/truncation.ts`): per-field caps, recursive normalization (max depth 10, max breadth 100, max string 32KB), and a 100KB total event budget with progressive falloff.
4. **Build PostHog events** — `buildPostHogCaptureEvents` (`posthog-events.ts:33`) fans one internal event out to up to **3 PostHog events**:
   - Always: the main `mcp_*` capture event.
   - If `event.isError && event.error`: a sibling `$exception` event.
   - If `enableAITracing && eventType === mcpToolsCall`: a sibling `$ai_span` event.
5. **Dispatch** — each event is handed to `posthog-node`'s `capture()`. Batching, retries, and flushing are owned by `posthog-node`. The SDK registers `SIGINT`/`SIGTERM`/`beforeExit` handlers that drain the queue (5s timeout) and call `shutdown()` on cached clients (`event-queue.ts:193`).

Buffering limits: queue capped at 10,000 events (oldest dropped with a warning), max 5 in-flight `capture()` calls.

## 4. Session & identity

- **Session ID format**: `ses_<32-hex>` (`src/modules/ids.ts:6`). Currently uses `randomUUID()` (UUIDv4). **Note**: commit `8d85ad4` claims UUIDv7 but the code never adopted that; if v7 is desired it's a small follow-up.
- **Session resolution order** (`src/modules/session.ts:36`):
  1. If `extra.sessionId` (MCP protocol session) is present, derive a deterministic id by hashing it (`deterministicPrefixedId("ses", mcpSessionId)`). This means the same protocol session always maps to the same PostHog session across server restarts.
  2. If the MCP session id disappears mid-stream, keep using the last derived id (transient drops don't split sessions).
  3. Otherwise, generate `ses_<uuidv4>` and rotate after **30 minutes of inactivity** (`INACTIVITY_TIMEOUT_IN_MINUTES`).
- **`distinct_id`** (`posthog-events.ts:11`): `identifyActorGivenId || sessionId || "anonymous"`. Pre-identify events are session-scoped; once `options.identify()` returns a user, subsequent events attribute to that user and PostHog's standard identity merge takes over.
- **`posthog_identify` event**: fires only when the identity returned by `options.identify()` _changes_ for a given session. There is a module-level LRU (max 1000 entries) keyed by session id (`src/modules/internal.ts:154`), so an unchanged identity is silently deduped.
- **Person properties (`$set`)**: built from `UserIdentity.userName` (→ `name`) and any `userData` keys (`posthog-events.ts:150`).

## 5. Event catalog

All events are emitted by `buildPostHogCaptureEvents`. The main event name is computed by `mapEventType()` (`posthog-events.ts:290`).

| PostHog event | When | Notable extras |
|---|---|---|
| `mcp_tool_call` | Every tool invocation | `$mcp_tool_name`, `$mcp_tool_description`, `$mcp_parameters`, `$mcp_response`, `$mcp_duration_ms`, `$mcp_is_error`, optionally `$mcp_intent` / `$mcp_intent_source`, AI trace refs if AI tracing on |
| `mcp_tools_list` | Client lists tools | No tool-specific fields; useful for "did this client discover us?" |
| `mcp_initialize` | Client/server handshake | `$mcp_client_name`, `$mcp_client_version`, `$mcp_server_name`, `$mcp_server_version` |
| `mcp_resources_list` | Client lists resources | — |
| `mcp_resource_read` | Resource fetched | `$mcp_resource_name`, `$mcp_parameters`, `$mcp_response` |
| `mcp_prompts_list` | Client lists prompts | — |
| `mcp_prompt_get` | Prompt fetched | `$mcp_resource_name` (= prompt name) |
| `mcp_custom` | `publishCustomEvent()` | Whatever the caller passed in `tags` / `properties` |
| `posthog_identify` | `options.identify` returned a new identity for the session | `$set` populated |
| `$exception` | Sibling to any errored event | `$exception_message`, `$exception_type`, `$exception_stacktrace`, `$exception_source = "backend"` |
| `$ai_span` | Sibling to `mcp_tool_call` when `enableAITracing: true` | Full `$ai_*` set — see §6 |

### Unknown event types

`mapEventType` falls back to `mcp_<eventType minus 'mcp:' prefix, slashes → underscores>`. This is what keeps custom event types from `publishCustomEvent` sane.

## 6. Property catalog

All wire keys live in `PostHogMCPAnalyticsProperty` (`src/modules/constants.ts:6`).

### Core properties (present on most `mcp_*` events)

| Constant | Wire key | Type | Source |
|---|---|---|---|
| `SessionId` | `$session_id` | string | `event.sessionId` (`ses_…`) |
| `Source` | `$mcp_source` | string | Hardcoded `"posthog_mcp_analytics"` |
| `ResourceName` | `$mcp_resource_name` | string | Tool / resource / prompt name |
| `ToolName` | `$mcp_tool_name` | string | Same as `ResourceName`, but **only on `mcp_tool_call`** |
| `ToolDescription` | `$mcp_tool_description` | string | Tool's current `description` at call time. Cached from `tools/list` and (for high-level `McpServer`) seeded from `_registeredTools`. Only on `mcp_tool_call` and the paired `$exception` event |
| `DurationMs` | `$mcp_duration_ms` | number (ms) | Wall-clock duration |
| `IsError` | `$mcp_is_error` | boolean | Set from tool result or thrown exception |
| `ServerName` | `$mcp_server_name` | string | `server._serverInfo.name` |
| `ServerVersion` | `$mcp_server_version` | string | `server._serverInfo.version` |
| `ClientName` | `$mcp_client_name` | string | `server.getClientVersion().name` |
| `ClientVersion` | `$mcp_client_version` | string | `server.getClientVersion().version` |
| `Intent` | `$mcp_intent` | string | `context` argument when present, else `intentFallback()` return |
| `IntentSource` | `$mcp_intent_source` | `"context_parameter" \| "inferred"` | Where the intent came from |
| `Parameters` | `$mcp_parameters` | object | Sanitized MCP request payload (see §3) |
| `Response` | `$mcp_response` | object | Sanitized tool result |

### Person properties (`$set`)

| Key | Source |
|---|---|
| `name` | `UserIdentity.userName` |
| `<anything>` | Top-level keys of `UserIdentity.userData` |

### AI tracing properties (`$ai_span` event + duplicated on `mcp_tool_call`)

| Constant | Wire key | Type | Notes |
|---|---|---|---|
| `AiSessionId` | `$ai_session_id` | string | `posthog_mcp_analytics_${sessionId}` — namespaced to avoid clashes |
| `AiTraceId` | `$ai_trace_id` | string | `event.sessionId` — all tool calls in a session share this |
| `AiSpanId` | `$ai_span_id` | string | `event.id` — unique per tool call (`evt_…`) |
| `AiSpanName` | `$ai_span_name` | string | Tool name |
| `AiIsError` | `$ai_is_error` | boolean | — |
| `AiLatency` | `$ai_latency` | number (**seconds**) | `duration_ms / 1000` — different unit from `$mcp_duration_ms` |
| `AiInputState` | `$ai_input_state` | object | Same content as `$mcp_parameters` |
| `AiOutputState` | `$ai_output_state` | object | Same content as `$mcp_response` |
| `$ai_error` | `$ai_error` | object | Set as a literal property, not via the constants enum |

`$ai_trace_id` and `$ai_span_id` are also stamped onto the main `mcp_tool_call` event (`posthog-events.ts:103`) so the two events can be joined.

### Exception properties (`$exception` event)

`$exception_source = "backend"`, `$exception_message`, `$exception_type`, `$exception_stacktrace`, plus `$session_id`, `$mcp_resource_name`, `$mcp_tool_name` and `$mcp_tool_description` (tool calls only), `$mcp_server_*`, `$mcp_client_*`.

### Customer-defined properties

`eventTags` and `eventProperties` callbacks return key/value pairs that are **spread flat at the top level of the PostHog event properties**, alongside the `$mcp_*` keys (`posthog-events.ts:162`). They can therefore override built-in `$mcp_*` keys — intentional, so customers can backfill missing context. Tags are validated (`src/modules/validation.ts`): key ≤32 chars matching `[a-zA-Z0-9$_.:\- ]`, value ≤200 chars no newlines, ≤50 entries. Invalid entries are dropped silently and logged to `~/posthog-mcp-analytics.log`.

## 7. Customer extension points (`MCPAnalyticsOptions`, `src/types.ts:26`)

| Option | Default | Use case |
|---|---|---|
| `apiKey` | — | PostHog project key (`phc_…`). Required unless you pass `posthogClient`. |
| `host` | `https://us.i.posthog.com` | Ingestion host. Overridden by `POSTHOG_MCP_ANALYTICS_HOST`. |
| `enableTracing` | `true` | Master kill switch for event emission. |
| `enableAITracing` | `false` | Emit `$ai_span` so MCP activity shows up in PostHog LLM analytics. |
| `reportMissing` | `false` | Register the `get_more_tools` virtual tool. |
| `context` | `true` (object form: `{ description }`) | Inject required `context` arg into every tool schema. |
| `intentFallback` | — | Consumer-supplied callback returning a `$mcp_intent` string when the client didn't pass a `context` argument. SDK does no inference of its own. |
| `identify` | — | Async function returning `UserIdentity \| null`. |
| `redactSensitiveInformation` | — | Async string-level redactor. Runs before sanitization. |
| `eventTags` | — | Indexed string metadata, spread flat. |
| `eventProperties` | — | Freeform JSON, spread flat. |
| `posthogClient` | — | BYO `posthog-node` client. |
| `posthogOptions` | — | Options forwarded to the SDK-managed `posthog-node` client. |

## 8. Useful queries

All queries assume `event` is the PostHog event name column. Property names use the literal wire keys (with `$`).

### Top tools per server (last 7d)
```sql
SELECT
  properties.$mcp_server_name AS server,
  properties.$mcp_tool_name   AS tool,
  count() AS calls
FROM events
WHERE event = 'mcp_tool_call' AND timestamp > now() - INTERVAL 7 DAY
GROUP BY server, tool
ORDER BY calls DESC
LIMIT 50
```

### Error rate per tool
```sql
SELECT
  properties.$mcp_tool_name AS tool,
  countIf(properties.$mcp_is_error)        AS errors,
  count()                                  AS total,
  countIf(properties.$mcp_is_error) / count() AS error_rate
FROM events
WHERE event = 'mcp_tool_call' AND timestamp > now() - INTERVAL 7 DAY
GROUP BY tool
ORDER BY total DESC
```

### P95 latency per tool
```sql
SELECT
  properties.$mcp_tool_name AS tool,
  quantile(0.95)(toFloat(properties.$mcp_duration_ms)) AS p95_ms
FROM events
WHERE event = 'mcp_tool_call' AND timestamp > now() - INTERVAL 7 DAY
GROUP BY tool
ORDER BY p95_ms DESC
```

### Intent samples split by source
Useful to see what fraction of intents come from explicit user-typed context vs the server's `intentFallback` callback.
```sql
SELECT
  properties.$mcp_intent_source AS source,
  properties.$mcp_tool_name     AS tool,
  any(properties.$mcp_intent)   AS sample_intent,
  count()                       AS calls
FROM events
WHERE event = 'mcp_tool_call' AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY source, tool
ORDER BY calls DESC
```

### Joining `mcp_tool_call` to its `$ai_span` sibling
The two events share `$ai_span_id`. PostHog's LLM analytics UI already does this join automatically — this query is for ad-hoc work.
```sql
SELECT
  c.properties.$mcp_tool_name    AS tool,
  c.properties.$mcp_duration_ms  AS duration_ms,
  s.properties.$ai_latency       AS ai_latency_s,
  c.properties.$mcp_intent       AS intent
FROM events c
INNER JOIN events s
  ON s.event = '$ai_span'
 AND s.properties.$ai_span_id = c.properties.$ai_span_id
WHERE c.event = 'mcp_tool_call'
  AND c.timestamp > now() - INTERVAL 24 HOUR
LIMIT 100
```

### Active sessions per client
```sql
SELECT
  properties.$mcp_client_name AS client,
  uniq(properties.$session_id) AS sessions
FROM events
WHERE event IN ('mcp_initialize', 'mcp_tool_call')
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY client
ORDER BY sessions DESC
```

## 9. Breaking changes vs upstream mcpcat

The original mcpcat SDK emitted analytics with no `$` prefix and used different key/value strings. Multiple PostHog-side renames have happened since. **Any insight that hardcoded an mcpcat-era key needs to be migrated.**

### Property renames

All driven by commit `078338b` ("fix: prefix mcp analytics properties") unless noted.

| Concept | Upstream mcpcat | Current `@posthog/mcp` |
|---|---|---|
| Source value (constant string) | `mcpcat` | `posthog_mcp_analytics` (commit `1ff7a83`) |
| Source property key | `source` | `$mcp_source` |
| Tool name | `tool_name` | `$mcp_tool_name` |
| Resource name | `resource_name` | `$mcp_resource_name` |
| Duration | `duration_ms` | `$mcp_duration_ms` |
| Error flag | `is_error` | `$mcp_is_error` |
| Client name / version | `client_name`, `client_version` | `$mcp_client_name`, `$mcp_client_version` |
| Server name / version | `server_name`, `server_version` | `$mcp_server_name`, `$mcp_server_version` |
| Request params | `parameters` | `$mcp_parameters` |
| Response payload | `response` | `$mcp_response` |
| User intent | `user_intent` → `$mcp_user_intent` → `$mcp_context` | `$mcp_intent` (commit `d5f2c26`) |
| AI product tag | `ai_product` | `$ai_product` (not actively populated — flag for cleanup) |

### Event-name renames

mcpcat-internal event types like `mcp:tools/call` and `mcpcat:custom` are now mapped to flat PostHog event names by `mapEventType()` (`posthog-events.ts:290`):

| Internal event type | PostHog event |
|---|---|
| `mcp:tools/call` | `mcp_tool_call` |
| `mcp:tools/list` | `mcp_tools_list` |
| `mcp:initialize` | `mcp_initialize` |
| `mcp:resources/read` | `mcp_resource_read` |
| `mcp:resources/list` | `mcp_resources_list` |
| `mcp:prompts/get` | `mcp_prompt_get` |
| `mcp:prompts/list` | `mcp_prompts_list` |
| `mcpcat:custom` | `mcp_custom` |
| `posthog:identify` | `posthog_identify` |

Originally the SDK published the literal internal event-type strings; the mapping was introduced in `d63b207` and stabilized into named constants in `345a29e`.

### Migration checklist for existing insights

1. Replace bare `source = "mcpcat"` filters with `properties.$mcp_source = "posthog_mcp_analytics"`.
2. Replace any `properties.user_intent` / `$mcp_user_intent` / `$mcp_context` reference with `properties.$mcp_intent`.
3. Replace bare `tool_name`, `resource_name`, `duration_ms`, etc. with their `$mcp_*` equivalents.
4. Replace `event = 'mcp:tools/call'` (etc.) with `event = 'mcp_tool_call'`.
5. Custom event filters previously matching `event = 'mcpcat:custom'` should now match `event = 'mcp_custom'`.

## 10. Intent resolution in depth

Intent is the most semantically-loaded property the SDK emits and it has the most subtle resolution logic. Lives in `src/modules/intent.ts`.

### Two sources, one property

`$mcp_intent` can come from either:

1. **The `context` argument the LLM/client passed** — the SDK-injected JSON-Schema parameter. Tagged `$mcp_intent_source = "context_parameter"`.
2. **The `intentFallback` callback you supplied** — runs only when no `context` argument is present. Tagged `$mcp_intent_source = "inferred"`.

Explicit context always wins. If `context` is non-empty, `intentFallback` is **not invoked**.

### Why the fallback exists

The `context` parameter is advertised as required in JSON Schema but **not enforced at the SDK validation layer** — a tool call with `arguments: {}` succeeds and lands in PostHog with `$mcp_intent` empty (verified by `src/tests/context-parameters.test.ts:244`).

The MCP SDK validates against the Zod schema the tool was originally registered with, and the SDK does not (and can't safely) re-derive Zod from the mutated JSON Schema. So for clients that ignore the JSON Schema hint — raw cURL, in-house agents, schema-blind crawlers — `intentFallback` is the only way to keep intent coverage non-zero.

For a tightly-controlled internal MCP server with a single well-behaved client, the fallback is dead code.

### What the SDK does NOT do

`intentFallback` is **a slot**, not a strategy. The SDK:

- Awaits whatever async function you pass.
- Trims and null-guards the result.
- Tags it `source: "inferred"`.
- Swallows + logs any thrown exception.

The SDK does **not**: call an LLM, inspect tool arguments, build heuristics, or cache results across calls. If you want any of that, your callback implements it.

### Recommended `intentFallback` patterns

1. **Deterministic, per-tool** (cheapest, sync, runs on every uncontextualized call):
   ```ts
   intentFallback: (request) => {
     const tool = request.params?.name;
     const args = request.params?.arguments ?? {};
     if (tool === "search_events") return `Searching events for "${args.query}"`;
     return tool ? `Invoking ${tool}` : null;
   }
   ```
2. **Transport metadata** (when `extra` carries user-agent or session info worth surfacing):
   ```ts
   intentFallback: (request, extra) => {
     const ua = extra?.requestInfo?.headers?.["user-agent"];
     return `${ua ?? "unknown client"} invoked ${request.params?.name}`;
   }
   ```
3. **LLM-derived** (async, expensive — push back unless the value is high). Sits on the hot path of every uncontextualized tool call.

### Known sharp edges

- The `get_more_tools` virtual tool always reports `$mcp_intent_source = "context_parameter"` (`src/modules/tracing-v2.ts:419`). It's defensible — the LLM did type a context string — but worth knowing if you segment by source.
- `$mcp_intent_source` is currently **only** present when an intent was captured. Events with neither a context arg nor a fallback result have no `$mcp_intent` and no `$mcp_intent_source`. Dashboards filtering on `$mcp_intent_source = "inferred"` won't see them — that's the desired behavior; just don't expect a synthetic `"none"` value.

---

## File map quick reference

| Concern | File |
|---|---|
| Public API entry | `src/index.ts` |
| Public types & options | `src/types.ts` |
| Property/event constants | `src/modules/constants.ts` |
| Event serialization to PostHog | `src/modules/posthog-events.ts` |
| Internal event types | `src/modules/event-types.ts` |
| In-memory queue + posthog-node dispatch | `src/modules/event-queue.ts` |
| High-level `McpServer` wrapping | `src/modules/tracing-v2.ts` |
| Low-level `Server` wrapping | `src/modules/tracing.ts` |
| Intent resolution (context arg + fallback) | `src/modules/intent.ts` |
| Identity cache | `src/modules/internal.ts` |
| Session id derivation & timeout | `src/modules/session.ts`, `src/modules/ids.ts` |
| Customer redaction | `src/modules/redaction.ts` |
| Auto-redaction & binary stubbing | `src/modules/sanitization.ts`, `src/modules/mcp-payloads.ts` |
| Size / depth / breadth caps | `src/modules/truncation.ts` |
| `eventTags` validation | `src/modules/validation.ts` |
| File logging (STDIO-safe) | `src/modules/logging.ts` |
| MCP SDK version compat shims | `src/modules/compatibility.ts`, `src/modules/mcp-sdk-compat.ts` |
