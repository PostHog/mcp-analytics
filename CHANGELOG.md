# @posthog/mcp

## 0.0.9

### Patch Changes

- 158b959: refactor: Simplify `executeReportMissingTool` to avoid being async
- 158b959: fix: Avoid interactivity when running `verify`
- 158b959: feat: Update and explain rationale behind each default annotation in the `get_more_tools` tool
- 158b959: feat: Support identification via hardcoded object rather than requiring function
- 158b959: chore: Add PostHog to the LICENSE

## 0.0.8

### Patch Changes

- e69f50f: Expose annotation hints on `report_missing` tool

## 0.0.7

### Patch Changes

- f31b895: Capture the tool names advertised in `tools/list` responses on the `mcp_tools_list` event as `$mcp_listed_tool_names` (string array). Lets you join `tools/list` ↔ `mcp_tool_call` events by `$session_id` to answer questions you can't reach with the existing schema, in particular: which advertised tools never get called? Useful for triaging description quality, naming, or whether a tool is even discoverable. Only meaningful in multi-tool registration mode — in single-exec dispatcher patterns the listed array always contains just the dispatcher's name.

## 0.0.6

### Patch Changes

- b75f97d: Customer-supplied `eventTags` and `eventProperties` now also reach the `$exception` event, the same way they already reach `mcp_tool_call` and `$ai_span`. Previously the exception event hand-picked a handful of `$mcp_*` fields and dropped everything the customer attached, which made error triage in PostHog miss most of the context the caller had carefully wired up (org id, project id, consumer, transport, mode, etc.). Same override semantics as the main event: customer keys can shadow built-in `$mcp_*` keys.

## 0.0.5

### Patch Changes

- 8955afc: Capture the tool's current description on `mcp_tool_call` and `$exception` events as `$mcp_tool_description`. This makes it possible to see, when triaging an errored call in PostHog, what the LLM thought the tool did at the time it was invoked — useful for projects with many tools where the description isn't memorable, and for evaluating whether description changes affect agent behavior over time. Descriptions are cached from `tools/list` and (for high-level `McpServer` servers) seeded directly from the tool registry, so the property is populated even on the first call.

## 0.0.4

### Patch Changes

- be25431: Add an opt-in `enableConversationId` option to `track()`. When enabled, the SDK injects an optional `conversation_id` argument into every tracked tool's input schema. If the agent omits it, the SDK mints a UUID and appends a prompt-back text block telling the agent to reuse the same value on subsequent calls. The value (agent-supplied or minted) is captured on PostHog events as a new `$mcp_conversation_id` property. `$session_id` behavior is unchanged. Off by default.

## 0.0.3

### Patch Changes

- 26c8992: Stabilize MCP analytics event contracts for tool-call duration, success state, and exported event constants.

## 0.0.2

### Patch Changes

- 93965cb: Update package release metadata and README rendering for npm.

## 0.0.1

### Patch Changes

- 38b3124: Initial early-access release of the PostHog MCP SDK for internal dogfooding.
