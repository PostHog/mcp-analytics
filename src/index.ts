import {
  isCompatibleServerType,
  isHighLevelServer,
} from "./modules/compatibility.js";
import {
  eventQueue,
  publishEvent as publishEventToQueue,
} from "./modules/event-queue.js";
import { MCPAnalyticsEventType } from "./modules/event-types.js";
import { captureException } from "./modules/exceptions.js";
import {
  getServerTrackingData,
  setServerTrackingData,
} from "./modules/internal.js";
import { writeToLog } from "./modules/logging.js";
import {
  deriveSessionIdFromMCPSession,
  getSessionInfo,
  newSessionId,
} from "./modules/session.js";
import { setupMCPAnalyticsTools } from "./modules/tools.js";
import { setupToolCallTracing } from "./modules/tracing.js";
import { setupTracking } from "./modules/tracing-v2.js";
import { validateTags } from "./modules/validation.js";
import type {
  CustomEventData,
  HighLevelMCPServerLike,
  MCPAnalyticsData,
  MCPAnalyticsOptions,
  MCPServerLike,
  UnredactedEvent,
  UserIdentity,
} from "./types.js";

/**
 * Integrates PostHog MCP into an MCP server to track tool usage patterns and user interactions.
 *
 * @param server - The MCP server instance to track. Must be a compatible MCP server implementation.
 * @param options - Configuration to customize tracking behavior.
 * @param options.apiKey - PostHog project API key (`phc_...`). Optional when using an injected `posthogClient`.
 * @param options.host - Custom PostHog ingestion host. Defaults to `https://us.i.posthog.com`.
 * @param options.reportMissing - Adds a "get_more_tools" tool that allows LLMs to automatically report missing functionality. Defaults to false.
 * @param options.enableAITracing - Emits `$ai_span` events for tool calls so MCP activity appears in PostHog LLM analytics. Defaults to false.
 * @param options.enableTracing - Enables tracking of tool calls and usage patterns.
 * @param options.context - Enables the required "context" parameter on tools to capture user intent. Pass false to disable, or an object with a custom description.
 * @param options.intentFallback - Optional consumer-supplied callback invoked when a tool call has no explicit `context` argument. Return a short user intent string to capture as `$mcp_intent` (with `$mcp_intent_source = "inferred"`). The SDK does not infer anything on its own — this is purely a slot for your own derivation logic (e.g. a switch on `request.params.name`, an LLM call, etc.). Runs on the hot path of every uncontextualized tool call.
 * @param options.identify - Async function to identify users and attach custom data to their sessions.
 * @param options.redactSensitiveInformation - Function to redact sensitive data before sending to PostHog.
 * @param options.eventTags - Callback invoked on every auto-captured event (tool calls, tool lists, initialize) to attach string key-value tags. Tags are intended to be indexed and queryable in PostHog — use them for structured metadata you'll want to filter or group by (e.g., trace IDs, environments, regions). Tags are validated client-side: keys must be ≤32 chars matching `[a-zA-Z0-9$_.:\- ]`, values must be strings ≤200 chars with no newlines, max 50 entries per event. Invalid entries are silently dropped with a warning logged to `~/posthog-mcp-analytics.log`. If the callback throws or returns null, tags are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.eventProperties - Callback invoked on every auto-captured event to attach flexible JSON metadata (device info, feature flags, nested context). No constraints beyond standard JSON types. If the callback throws or returns null, properties are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.posthogClient - Optional existing posthog-node compatible client. If provided, MCP events are captured with that client instead of creating a new one.
 * @param options.posthogOptions - Optional posthog-node options used when the SDK creates its own client.
 *
 * @returns The tracked server instance.
 *
 * @remarks
 * Analytics data and debug information are logged to `~/posthog-mcp-analytics.log` since console logs interfere
 * with STDIO-based MCP servers.
 *
 * Do not call `track()` multiple times on the same server instance as this will cause unexpected behavior.
 *
 * @example
 * ```typescript
 * import { track } from "@posthog/mcp";
 *
 * const mcpServer = new Server({ name: "my-mcp-server", version: "1.0.0" });
 *
 * // Track the server with PostHog MCP
 * track(mcpServer, { apiKey: "phc_abc123xyz" });
 *
 * // Register your tools
 * mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
 *   tools: [{ name: "my_tool", description: "Does something useful" }]
 * }));
 * ```
 *
 * @example
 * ```typescript
 * // With user identification
 * track(mcpServer, {
 *   apiKey: "phc_abc123xyz",
 *   identify: async (request, extra) => {
 *     const user = await getUserFromToken(request.params.arguments.token);
 *     return {
 *       userId: user.id,
 *       userData: { plan: user.plan, company: user.company }
 *     };
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With custom context description
 * track(mcpServer, {
 *   apiKey: "phc_abc123xyz",
 *   context: {
 *     description: "Explain why you're calling this tool and what business objective it helps achieve"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With sensitive data redaction
 * track(mcpServer, {
 *   apiKey: "phc_abc123xyz",
 *   redactSensitiveInformation: async (text) => {
 *     return text.replace(/api_key_\w+/g, "[REDACTED]");
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With event tags and properties
 * track(mcpServer, {
 *   apiKey: "phc_abc123xyz",
 *   eventTags: async (request, extra) => ({
 *     trace_id: extra?.requestContext?.traceId,
 *     env: process.env.NODE_ENV,
 *     region: "us-east-1",
 *   }),
 *   eventProperties: async (request, extra) => ({
 *     device: "desktop",
 *     app_version: "2.1.0",
 *     feature_flags: ["dark_mode", "beta_ui"],
 *   }),
 * });
 * ```
 *
 * @example
 * ```typescript
 */
function track<TServer>(
  server: TServer,
  options: MCPAnalyticsOptions = {}
): TServer {
  try {
    const validatedServer = isCompatibleServerType(server);
    const lowLevelServer = getLowLevelServer(validatedServer);

    configureIngestion(options);

    const existingData = getServerTrackingData(lowLevelServer);
    if (existingData) {
      writeToLog(
        "[SESSION DEBUG] track() - Server already being tracked, skipping initialization"
      );
      return validatedServer as TServer;
    }

    if (!(options.apiKey || options.posthogClient)) {
      writeToLog(
        "Warning: No PostHog API key or PostHog client configured. Events will not be sent anywhere."
      );
    }

    const mcpAnalyticsData = buildTrackingData(lowLevelServer, options);

    setServerTrackingData(lowLevelServer, mcpAnalyticsData);
    setupTrackedServer(validatedServer, lowLevelServer, mcpAnalyticsData);

    return validatedServer as TServer;
  } catch (error) {
    writeToLog(`Warning: Failed to track server - ${error}`);
    return server;
  }
}

function getLowLevelServer(
  server: MCPServerLike | HighLevelMCPServerLike
): MCPServerLike {
  return isHighLevelServer(server)
    ? (server as HighLevelMCPServerLike).server
    : (server as MCPServerLike);
}

function configureIngestion(options: MCPAnalyticsOptions): void {
  const host = options.host || process.env.POSTHOG_MCP_ANALYTICS_HOST;
  if (options.posthogOptions) {
    eventQueue.configurePostHogOptions(options.posthogOptions);
  }
  if (host) {
    eventQueue.configure(host);
  }
}

function buildTrackingData(
  lowLevelServer: MCPServerLike,
  options: MCPAnalyticsOptions
): MCPAnalyticsData {
  return {
    apiKey: options.apiKey || "",
    sessionId: newSessionId(),
    lastActivity: new Date(),
    identifiedSessions: new Map<string, UserIdentity>(),
    sessionInfo: getSessionInfo(lowLevelServer, undefined),
    options: {
      reportMissing: options.reportMissing ?? false,
      enableAITracing: options.enableAITracing ?? false,
      enableTracing: options.enableTracing ?? true,
      context: options.context,
      intentFallback: options.intentFallback,
      identify: options.identify,
      redactSensitiveInformation: options.redactSensitiveInformation,
      eventTags: options.eventTags,
      eventProperties: options.eventProperties,
      host: options.host,
      posthogClient: options.posthogClient,
      posthogOptions: options.posthogOptions,
      enableConversationId: options.enableConversationId ?? false,
    },
    sessionSource: "generated",
  };
}

function setupTrackedServer(
  validatedServer: MCPServerLike | HighLevelMCPServerLike,
  lowLevelServer: MCPServerLike,
  mcpAnalyticsData: MCPAnalyticsData
): void {
  if (isHighLevelServer(validatedServer)) {
    const highLevelServer = validatedServer as HighLevelMCPServerLike;
    setupTracking(highLevelServer);
  } else {
    if (mcpAnalyticsData.options.reportMissing) {
      try {
        setupMCPAnalyticsTools(lowLevelServer);
      } catch (error) {
        writeToLog(`Warning: Failed to setup report missing tool - ${error}`);
      }
    }

    if (mcpAnalyticsData.options.enableTracing) {
      try {
        setupToolCallTracing(lowLevelServer);
      } catch (error) {
        writeToLog(`Warning: Failed to setup tool call tracing - ${error}`);
      }
    }
  }
}

/**
 * Publishes a custom event to PostHog MCP with flexible session management.
 *
 * @param serverOrSessionId - Either a tracked MCP server instance or a MCP session ID string
 * @param eventData - Event data to include with the custom event. `apiKey` is required when publishing against a raw session ID.
 *
 * @returns Promise that resolves when the event is queued for publishing
 *
 * @example
 * ```typescript
 * // With a tracked server
 * await publishCustomEvent(
 *   server,
 *   {
 *     resourceName: "custom-action",
 *     parameters: { action: "user-feedback", rating: 5 },
 *     message: "User provided feedback"
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // With a MCP session ID
 * await publishCustomEvent(
 *   "user-session-12345",
 *   {
 *     apiKey: "phc_abc123xyz",
 *     isError: true,
 *     error: { message: "Custom error occurred", code: "ERR_001" }
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * await publishCustomEvent(
 *   server,
 *   {
 *     resourceName: "feature-usage",
 *   }
 * );
 * ```
 */
export function publishCustomEvent(
  serverOrSessionId: unknown,
  eventData: CustomEventData = {}
): Promise<void> {
  try {
    publishCustomEventSync(serverOrSessionId, eventData);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

function publishCustomEventSync(
  serverOrSessionId: unknown,
  eventData: CustomEventData
): void {
  const target = resolveCustomEventTarget(serverOrSessionId, eventData);

  const event: UnredactedEvent = {
    sessionId: target.sessionId,
    apiKey: target.apiKey,
    eventType: MCPAnalyticsEventType.custom,
    timestamp: new Date(),
    resourceName: eventData?.resourceName,
    parameters: eventData?.parameters,
    response: eventData?.response,
    userIntent: eventData?.message,
    duration: eventData?.duration,
    isError: eventData?.isError,
    error: resolveCustomEventError(eventData?.error),
  };

  if (eventData?.tags) {
    event.tags = validateTags(eventData.tags);
  }
  if (eventData?.properties && Object.keys(eventData.properties).length > 0) {
    event.properties = eventData.properties;
  }

  publishResolvedCustomEvent(target, event);

  writeToLog(
    `Published custom event for session ${target.sessionId} with type '${MCPAnalyticsEventType.custom}'`
  );
}

function resolveCustomEventError(error: unknown): UnredactedEvent["error"] {
  if (error === undefined || error === null) {
    return error;
  }

  if (
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error as UnredactedEvent["error"];
  }

  return captureException(error);
}

interface CustomEventTarget {
  apiKey: string;
  lowLevelServer: MCPServerLike | null;
  posthogClient?: MCPAnalyticsOptions["posthogClient"];
  sessionId: string;
}

function resolveCustomEventTarget(
  serverOrSessionId: unknown,
  eventData: CustomEventData
): CustomEventTarget {
  if (typeof serverOrSessionId === "string") {
    return resolveSessionIdTarget(serverOrSessionId, eventData);
  }

  if (serverOrSessionId && typeof serverOrSessionId === "object") {
    return resolveTrackedServerTarget(serverOrSessionId);
  }

  throw new Error(
    "First parameter must be either an MCP server object or a session ID string"
  );
}

function resolveSessionIdTarget(
  sessionIdInput: string,
  eventData: CustomEventData
): CustomEventTarget {
  const apiKey = eventData.apiKey || "";
  if (!(apiKey || eventData.posthogClient)) {
    throw new Error(
      "apiKey or posthogClient is required when publishing with a session ID"
    );
  }

  return {
    apiKey,
    lowLevelServer: null,
    posthogClient: eventData.posthogClient,
    sessionId: deriveSessionIdFromMCPSession(sessionIdInput),
  };
}

function resolveTrackedServerTarget(server: object): CustomEventTarget {
  const lowLevelServer = getLowLevelServerFromUnknownObject(server);
  const trackingData = getServerTrackingData(lowLevelServer);

  if (!trackingData) {
    throw new Error(
      "Server is not tracked. Please call track() first or provide a session ID string."
    );
  }

  return {
    apiKey: trackingData.apiKey,
    lowLevelServer,
    posthogClient: trackingData.options.posthogClient,
    sessionId: trackingData.sessionId,
  };
}

function getLowLevelServerFromUnknownObject(server: object): MCPServerLike {
  return "server" in server &&
    server.server &&
    typeof server.server === "object"
    ? (server.server as MCPServerLike)
    : (server as MCPServerLike);
}

function publishResolvedCustomEvent(
  target: CustomEventTarget,
  event: UnredactedEvent
): void {
  if (target.lowLevelServer && getServerTrackingData(target.lowLevelServer)) {
    publishEventToQueue(target.lowLevelServer, event);
    return;
  }

  if (target.posthogClient) {
    eventQueue.add(event, target.posthogClient);
    return;
  }

  eventQueue.add(event);
}

export type {
  CustomEventData,
  MCPAnalyticsContextOptions,
  MCPAnalyticsIntentSource,
  MCPAnalyticsOptions,
  RedactFunction,
  UserIdentity,
} from "./types.js";

export type IdentifyFunction = MCPAnalyticsOptions["identify"];

// biome-ignore lint/performance/noBarrelFile: the package entrypoint intentionally defines the public SDK API.
export {
  POSTHOG_MCP_ANALYTICS_SOURCE,
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
} from "./modules/constants.js";
export { track };
