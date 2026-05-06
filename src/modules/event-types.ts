export const MCPAnalyticsEventType = {
  identify: "posthog:identify",
  custom: "posthog:custom",
  mcpInitialize: "mcp:initialize",
  mcpPromptsGet: "mcp:prompts/get",
  mcpPromptsList: "mcp:prompts/list",
  mcpResourcesList: "mcp:resources/list",
  mcpResourcesRead: "mcp:resources/read",
  mcpToolsCall: "mcp:tools/call",
  mcpToolsList: "mcp:tools/list",
} as const;

export type MCPAnalyticsEventType =
  (typeof MCPAnalyticsEventType)[keyof typeof MCPAnalyticsEventType];
