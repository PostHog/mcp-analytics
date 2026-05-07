import type { Event } from "../types.js";
import {
  POSTHOG_MCP_ANALYTICS_SOURCE,
  PostHogMCPAnalyticsProperty,
} from "./constants.js";
import { MCPAnalyticsEventType } from "./event-types.js";

const MCP_EVENT_PREFIX_REGEX = /^mcp:/;
const SLASH_REGEX = /\//g;

function getDistinctId(event: Event): string {
  return event.identifyActorGivenId || event.sessionId || "anonymous";
}

function getTimestamp(event: Event): string {
  return event.timestamp
    ? event.timestamp.toISOString()
    : new Date().toISOString();
}

export interface PostHogCaptureEvent {
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  type: "capture";
}

export interface BuildPostHogCaptureEventsOptions {
  enableAITracing?: boolean;
}

export function buildPostHogCaptureEvents(
  event: Event,
  options: BuildPostHogCaptureEventsOptions = {}
): PostHogCaptureEvent[] {
  const batch = [buildCaptureEvent(event, options)];

  if (event.isError && event.error) {
    batch.push(buildExceptionEvent(event));
  }

  if (shouldBuildAISpan(event, options)) {
    batch.push(buildAISpanEvent(event));
  }

  return batch;
}

function buildCaptureEvent(
  event: Event,
  options: BuildPostHogCaptureEventsOptions
): PostHogCaptureEvent {
  const distinctId = getDistinctId(event);
  const eventName = mapEventType(event.eventType);
  const timestamp = getTimestamp(event);

  const properties: Record<string, unknown> = {
    [PostHogMCPAnalyticsProperty.SessionId]: event.sessionId,
    [PostHogMCPAnalyticsProperty.Source]: POSTHOG_MCP_ANALYTICS_SOURCE,
  };

  addCommonEventProperties(event, properties);
  addTraceReferenceProperties(event, properties, options);
  addCustomEventProperties(event, properties);

  return {
    event: eventName,
    distinct_id: distinctId,
    properties,
    timestamp,
    type: "capture",
  };
}

function shouldBuildAISpan(
  event: Event,
  options: BuildPostHogCaptureEventsOptions
): boolean {
  return (
    options.enableAITracing === true &&
    event.eventType === MCPAnalyticsEventType.mcpToolsCall
  );
}

function getAITraceId(event: Event): string {
  return event.sessionId;
}

function getAISpanId(event: Event): string {
  return event.id;
}

function addTraceReferenceProperties(
  event: Event,
  properties: Record<string, unknown>,
  options: BuildPostHogCaptureEventsOptions
): void {
  if (!shouldBuildAISpan(event, options)) {
    return;
  }

  properties[PostHogMCPAnalyticsProperty.AiTraceId] = getAITraceId(event);
  properties[PostHogMCPAnalyticsProperty.AiSpanId] = getAISpanId(event);
}

function addCommonEventProperties(
  event: Event,
  properties: Record<string, unknown>
): void {
  if (event.resourceName) {
    properties[PostHogMCPAnalyticsProperty.ResourceName] = event.resourceName;
    if (event.eventType === MCPAnalyticsEventType.mcpToolsCall) {
      properties[PostHogMCPAnalyticsProperty.ToolName] = event.resourceName;
    }
  }
  if (event.duration !== undefined) {
    properties[PostHogMCPAnalyticsProperty.DurationMs] = event.duration;
  }
  if (event.serverName) {
    properties[PostHogMCPAnalyticsProperty.ServerName] = event.serverName;
  }
  if (event.serverVersion) {
    properties[PostHogMCPAnalyticsProperty.ServerVersion] = event.serverVersion;
  }
  if (event.clientName) {
    properties[PostHogMCPAnalyticsProperty.ClientName] = event.clientName;
  }
  if (event.clientVersion) {
    properties[PostHogMCPAnalyticsProperty.ClientVersion] = event.clientVersion;
  }
  if (event.userIntent) {
    properties[PostHogMCPAnalyticsProperty.Intent] = event.userIntent;
  }
  if (event.isError !== undefined) {
    properties[PostHogMCPAnalyticsProperty.IsError] = event.isError;
  }

  if (event.parameters !== undefined) {
    properties[PostHogMCPAnalyticsProperty.Parameters] = event.parameters;
  }
  if (event.response !== undefined) {
    properties[PostHogMCPAnalyticsProperty.Response] = event.response;
  }

  const $set: Record<string, unknown> = {};
  if (event.identifyActorName) {
    $set.name = event.identifyActorName;
  }
  if (event.identifyActorData) {
    Object.assign($set, event.identifyActorData);
  }
  if (Object.keys($set).length > 0) {
    properties.$set = $set;
  }
}

function addCustomEventProperties(
  event: Event,
  properties: Record<string, unknown>
): void {
  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      properties[key] = value;
    }
  }

  if (event.properties) {
    for (const [key, value] of Object.entries(event.properties)) {
      properties[key] = value;
    }
  }
}

function buildExceptionEvent(event: Event): PostHogCaptureEvent {
  const distinctId = getDistinctId(event);
  const timestamp = getTimestamp(event);

  const properties: Record<string, unknown> = {
    $exception_source: "backend",
    [PostHogMCPAnalyticsProperty.SessionId]: event.sessionId,
  };

  if (event.error) {
    if (event.error.message) {
      properties.$exception_message = event.error.message;
    }
    if (event.error.type) {
      properties.$exception_type = event.error.type;
    }
    if (event.error.stack) {
      properties.$exception_stacktrace = event.error.stack;
    }
  }

  if (event.resourceName) {
    properties[PostHogMCPAnalyticsProperty.ResourceName] = event.resourceName;
    if (event.eventType === MCPAnalyticsEventType.mcpToolsCall) {
      properties[PostHogMCPAnalyticsProperty.ToolName] = event.resourceName;
    }
  }
  if (event.serverName) {
    properties[PostHogMCPAnalyticsProperty.ServerName] = event.serverName;
  }
  if (event.serverVersion) {
    properties[PostHogMCPAnalyticsProperty.ServerVersion] = event.serverVersion;
  }
  if (event.clientName) {
    properties[PostHogMCPAnalyticsProperty.ClientName] = event.clientName;
  }
  if (event.clientVersion) {
    properties[PostHogMCPAnalyticsProperty.ClientVersion] = event.clientVersion;
  }

  return {
    event: "$exception",
    distinct_id: distinctId,
    properties,
    timestamp,
    type: "capture",
  };
}

function buildAISpanEvent(event: Event): PostHogCaptureEvent {
  const distinctId = getDistinctId(event);
  const timestamp = getTimestamp(event);

  const properties: Record<string, unknown> = {
    [PostHogMCPAnalyticsProperty.AiSessionId]: `posthog_mcp_analytics_${event.sessionId}`,
    [PostHogMCPAnalyticsProperty.AiTraceId]: getAITraceId(event),
    [PostHogMCPAnalyticsProperty.AiSpanId]: getAISpanId(event),
    [PostHogMCPAnalyticsProperty.AiSpanName]:
      event.resourceName || "unknown_tool",
    [PostHogMCPAnalyticsProperty.AiIsError]: event.isError,
    [PostHogMCPAnalyticsProperty.SessionId]: event.sessionId,
    [PostHogMCPAnalyticsProperty.Source]: POSTHOG_MCP_ANALYTICS_SOURCE,
  };

  if (event.duration !== undefined) {
    properties[PostHogMCPAnalyticsProperty.AiLatency] = event.duration / 1000;
  }
  if (event.isError && event.error) {
    properties.$ai_error = event.error;
  }
  if (event.parameters !== undefined) {
    properties[PostHogMCPAnalyticsProperty.AiInputState] = event.parameters;
  }
  if (event.response !== undefined) {
    properties[PostHogMCPAnalyticsProperty.AiOutputState] = event.response;
  }
  if (event.serverName) {
    properties[PostHogMCPAnalyticsProperty.ServerName] = event.serverName;
  }
  if (event.clientName) {
    properties[PostHogMCPAnalyticsProperty.ClientName] = event.clientName;
  }
  if (event.userIntent) {
    properties[PostHogMCPAnalyticsProperty.Intent] = event.userIntent;
  }

  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      properties[key] = value;
    }
  }

  if (event.properties) {
    for (const [key, value] of Object.entries(event.properties)) {
      properties[key] = value;
    }
  }

  return {
    event: "$ai_span",
    distinct_id: distinctId,
    properties,
    timestamp,
    type: "capture",
  };
}

function mapEventType(eventType: string): string {
  const mapping: Record<string, string> = {
    [MCPAnalyticsEventType.mcpToolsCall]: "mcp_tool_call",
    [MCPAnalyticsEventType.mcpToolsList]: "mcp_tools_list",
    [MCPAnalyticsEventType.mcpInitialize]: "mcp_initialize",
    [MCPAnalyticsEventType.mcpResourcesRead]: "mcp_resource_read",
    [MCPAnalyticsEventType.mcpResourcesList]: "mcp_resources_list",
    [MCPAnalyticsEventType.mcpPromptsGet]: "mcp_prompt_get",
    [MCPAnalyticsEventType.mcpPromptsList]: "mcp_prompts_list",
  };

  return (
    mapping[eventType] ||
    `mcp_${eventType.replace(MCP_EVENT_PREFIX_REGEX, "").replace(SLASH_REGEX, "_")}`
  );
}
