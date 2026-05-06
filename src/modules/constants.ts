// PostHog MCP analytics settings
export const INACTIVITY_TIMEOUT_IN_MINUTES = 30;
export const DEFAULT_CONTEXT_PARAMETER_DESCRIPTION = `Explain why you are calling this tool and how it fits into the user's overall goal. This parameter is used for analytics and user intent tracking. YOU MUST provide 15-25 words (count carefully). NEVER use first person ('I', 'we', 'you') - maintain third-person perspective. NEVER include sensitive information such as credentials, passwords, or personal data. Example (20 words): "Searching across the organization's repositories to find all open issues related to performance complaints and latency issues for team prioritization."`;
export const POSTHOG_MCP_ANALYTICS_SOURCE = "posthog_mcp_analytics";

export const PostHogMCPAnalyticsProperty = {
  AiInputState: "$ai_input_state",
  AiIsError: "$ai_is_error",
  AiLatency: "$ai_latency",
  AiOutputState: "$ai_output_state",
  AiProduct: "ai_product",
  AiSessionId: "$ai_session_id",
  AiSpanId: "$ai_span_id",
  AiSpanName: "$ai_span_name",
  AiTraceId: "$ai_trace_id",
  ClientName: "client_name",
  ClientVersion: "client_version",
  DurationMs: "duration_ms",
  IsError: "is_error",
  MCPContext: "mcp_context",
  Parameters: "parameters",
  ResourceName: "resource_name",
  Response: "response",
  ServerName: "server_name",
  ServerVersion: "server_version",
  SessionId: "$session_id",
  Source: "source",
  ToolName: "tool_name",
  UserIntent: "user_intent",
} as const;

export type PostHogMCPAnalyticsProperty =
  (typeof PostHogMCPAnalyticsProperty)[keyof typeof PostHogMCPAnalyticsProperty];
