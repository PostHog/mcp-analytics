---
"@posthog/mcp": patch
---

Capture the tool's current description on `mcp_tool_call` and `$exception` events as `$mcp_tool_description`. This makes it possible to see, when triaging an errored call in PostHog, what the LLM thought the tool did at the time it was invoked — useful for projects with many tools where the description isn't memorable, and for evaluating whether description changes affect agent behavior over time. Descriptions are cached from `tools/list` and (for high-level `McpServer` servers) seeded directly from the tool registry, so the property is populated even on the first call.
