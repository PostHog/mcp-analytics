---
"@posthog/mcp": patch
---

Add an opt-in `enableConversationId` option to `track()`. When enabled, the SDK injects an optional `conversation_id` argument into every tracked tool's input schema. If the agent omits it, the SDK mints a UUID and appends a prompt-back text block telling the agent to reuse the same value on subsequent calls. The value (agent-supplied or minted) is captured on PostHog events as a new `$mcp_conversation_id` property. `$session_id` behavior is unchanged. Off by default.
