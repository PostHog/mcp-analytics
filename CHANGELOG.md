# @posthog/mcp

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
