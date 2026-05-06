import { createHash } from "node:crypto";
import KSUID from "../../thirdparty/ksuid/index.js";
import type { Event, Exporter } from "../../types.js";
import {
  POSTHOG_MCP_ANALYTICS_SOURCE,
  PostHogMCPAnalyticsProperty,
} from "../constants.js";
import { MCPAnalyticsEventType } from "../event-types.js";
import { writeToLog } from "../logging.js";

const PREFIXED_KSUID_REGEX = /^[a-z]+_/;
const MCP_EVENT_PREFIX_REGEX = /^mcp:/;
const SLASH_REGEX = /\//g;
const TRAILING_SLASH_REGEX = /\/$/;

/**
 * Generates a deterministic UUIDv7 from a prefixed KSUID (e.g. ses_xxx).
 * Uses the KSUID's embedded timestamp for the UUIDv7 timestamp portion
 * and a SHA-256 hash of the full ID for the random bits.
 */
export function toUUIDv7(prefixedId: string): string {
  // Strip prefix (ses_, evt_, etc.) and parse KSUID
  const ksuidStr = prefixedId.replace(PREFIXED_KSUID_REGEX, "");
  let timestampMs: number;
  try {
    const ksuid = KSUID.parse(ksuidStr);
    timestampMs = ksuid.date.getTime();
  } catch {
    // Fallback: if KSUID parsing fails, use current time
    timestampMs = Date.now();
  }

  // Hash the full ID for deterministic random bits
  const hash = createHash("sha256").update(prefixedId).digest();

  const buf = Buffer.alloc(16);

  // Bytes 0-5: 48-bit Unix timestamp in milliseconds
  buf.writeUIntBE(timestampMs, 0, 6);

  // Byte 6: version 7 (0111) + high 4 bits of rand_a from hash
  buf[6] = 0x70 + (hash[0] % 16);
  // Byte 7: low 8 bits of rand_a from hash
  buf[7] = hash[1];

  // Byte 8: variant 10 + high 6 bits of rand_b from hash
  buf[8] = 0x80 + (hash[2] % 64);
  // Bytes 9-15: remaining rand_b from hash
  buf[9] = hash[3];
  buf[10] = hash[4];
  buf[11] = hash[5];
  buf[12] = hash[6];
  buf[13] = hash[7];
  buf[14] = hash[8];
  buf[15] = hash[9];

  const hex = buf.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function getDistinctId(event: Event): string {
  return event.identifyActorGivenId || event.sessionId || "anonymous";
}

function getTimestamp(event: Event): string {
  return event.timestamp
    ? event.timestamp.toISOString()
    : new Date().toISOString();
}

export interface PostHogExporterConfig {
  apiKey: string; // PostHog project API key (e.g. phc_...)
  /**
   * Emits `$ai_span` events for tool calls alongside regular capture events,
   * integrating with PostHog's AI observability views. Each tool call is its own
   * trace (`$ai_trace_id`), grouped into sessions via `$ai_session_id`.
   * Customer-defined `eventTags` are spread directly onto `$ai_span` properties
   * and can override any default, including reserved `$ai_*` fields.
   * @default false
   */
  enableAITracing?: boolean;
  host?: string; // Default: "https://us.i.posthog.com" (supports self-hosted & EU region)
  type: "posthog";
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
  const batch = [buildCaptureEvent(event)];

  if (event.isError && event.error) {
    batch.push(buildExceptionEvent(event));
  }

  if (
    options.enableAITracing &&
    event.eventType === MCPAnalyticsEventType.mcpToolsCall
  ) {
    batch.push(buildAISpanEvent(event));
  }

  return batch;
}

function buildCaptureEvent(event: Event): PostHogCaptureEvent {
  const distinctId = getDistinctId(event);
  const eventName = mapEventType(event.eventType);
  const timestamp = getTimestamp(event);

  const properties: Record<string, unknown> = {
    [PostHogMCPAnalyticsProperty.SessionId]: toUUIDv7(event.sessionId),
    [PostHogMCPAnalyticsProperty.Source]: POSTHOG_MCP_ANALYTICS_SOURCE,
  };

  addCommonEventProperties(event, properties);
  addCustomEventProperties(event, properties);

  return {
    event: eventName,
    distinct_id: distinctId,
    properties,
    timestamp,
    type: "capture",
  };
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
    properties[PostHogMCPAnalyticsProperty.UserIntent] = event.userIntent;
    properties[PostHogMCPAnalyticsProperty.MCPContext] = event.userIntent;
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
    [PostHogMCPAnalyticsProperty.SessionId]: toUUIDv7(event.sessionId),
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
    [PostHogMCPAnalyticsProperty.AiTraceId]: toUUIDv7(event.sessionId),
    [PostHogMCPAnalyticsProperty.AiSpanId]: toUUIDv7(event.id),
    [PostHogMCPAnalyticsProperty.AiSpanName]:
      event.resourceName || "unknown_tool",
    [PostHogMCPAnalyticsProperty.AiIsError]: event.isError,
    [PostHogMCPAnalyticsProperty.SessionId]: toUUIDv7(event.sessionId),
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
    properties[PostHogMCPAnalyticsProperty.UserIntent] = event.userIntent;
    properties[PostHogMCPAnalyticsProperty.MCPContext] = event.userIntent;
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

export class PostHogExporter implements Exporter {
  private readonly batchUrl: string;
  private readonly apiKey: string;
  private readonly config: PostHogExporterConfig;

  constructor(config: PostHogExporterConfig) {
    this.config = config;
    const host = (config.host || "https://us.i.posthog.com").replace(
      TRAILING_SLASH_REGEX,
      ""
    );
    this.batchUrl = `${host}/batch`;
    this.apiKey = config.apiKey;

    writeToLog(`PostHogExporter: Initialized with endpoint ${this.batchUrl}`);
  }

  async export(event: Event): Promise<void> {
    try {
      const batch = buildPostHogCaptureEvents(event, {
        enableAITracing: this.config.enableAITracing,
      });

      writeToLog(
        `PostHogExporter: Sending ${batch.length} event(s) for ${event.id}`
      );

      const response = await fetch(this.batchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          batch,
        }),
      });

      if (response.ok) {
        writeToLog(`PostHog export success - Event: ${event.id}`);
      } else {
        const errorBody = await response.text();
        writeToLog(
          `PostHog export failed - Status: ${response.status}, Body: ${errorBody}`
        );
      }
    } catch (error) {
      writeToLog(`PostHog export error: ${error}`);
    }
  }
}
