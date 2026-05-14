---
"@posthog/mcp": patch
---

Capture the tool names advertised in `tools/list` responses on the `mcp_tools_list` event as `$mcp_listed_tool_names` (string array). Lets you join `tools/list` ↔ `mcp_tool_call` events by `$session_id` to answer questions you can't reach with the existing schema, in particular: which advertised tools never get called? Useful for triaging description quality, naming, or whether a tool is even discoverable. Only meaningful in multi-tool registration mode — in single-exec dispatcher patterns the listed array always contains just the dispatcher's name.
