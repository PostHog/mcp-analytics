---
"@posthog/mcp": patch
---

Customer-supplied `eventTags` and `eventProperties` now also reach the `$exception` event, the same way they already reach `mcp_tool_call` and `$ai_span`. Previously the exception event hand-picked a handful of `$mcp_*` fields and dropped everything the customer attached, which made error triage in PostHog miss most of the context the caller had carefully wired up (org id, project id, consumer, transport, mode, etc.). Same override semantics as the main event: customer keys can shadow built-in `$mcp_*` keys.
