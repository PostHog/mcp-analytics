// Import our minimal interface from types

// Import from modules
import {
  isCompatibleServerType,
  isHighLevelServer,
} from "./modules/compatibility.js";
import { MCPAnalyticsEventType } from "./modules/event-types.js";
import {
  eventQueue,
  publishEvent as publishEventToQueue,
  setTelemetryManager,
} from "./modules/eventQueue.js";
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
import { TelemetryManager } from "./modules/telemetry.js";
import { setupMCPAnalyticsTools } from "./modules/tools.js";
import { setupToolCallTracing } from "./modules/tracing.js";
import { setupTracking } from "./modules/tracingV2.js";
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
 * Integrates PostHog MCP analytics analytics into an MCP server to track tool usage patterns and user interactions.
 *
 * @param server - The MCP server instance to track. Must be a compatible MCP server implementation.
 * @param projectId - Your PostHog MCP analytics project ID obtained from posthog.com when creating an account. Pass null for telemetry-only mode.
 * @param options - Optional configuration to customize tracking behavior.
 * @param options.enableReportMissing - Adds a "get_more_tools" tool that allows LLMs to automatically report missing functionality.
 * @param options.enableTracing - Enables tracking of tool calls and usage patterns.
 * @param options.enableToolCallContext - Injects a "context" parameter to existing tools to capture user intent.
 * @param options.customContextDescription - Custom description for the injected context parameter. Only applies when enableToolCallContext is true. Use this to provide domain-specific guidance to LLMs about what context they should provide.
 * @param options.identify - Async function to identify users and attach custom data to their sessions.
 * @param options.redactSensitiveInformation - Function to redact sensitive data before sending to PostHog MCP analytics.
 * @param options.eventTags - Callback invoked on every auto-captured event (tool calls, tool lists, initialize) to attach string key-value tags. Tags are intended to be indexed and queryable in the PostHog MCP analytics dashboard — use them for structured metadata you'll want to filter or group by (e.g., trace IDs, environments, regions). Tags are validated client-side: keys must be ≤32 chars matching `[a-zA-Z0-9$_.:\- ]`, values must be strings ≤200 chars with no newlines, max 50 entries per event. Invalid entries are silently dropped with a warning logged to `~/posthog-mcp-analytics.log`. If the callback throws or returns null, tags are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.eventProperties - Callback invoked on every auto-captured event to attach flexible JSON metadata (device info, feature flags, nested context). No constraints beyond standard JSON types. If the callback throws or returns null, properties are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.apiBaseUrl - Custom API base URL for sending events. Falls back to the `POSTHOG_MCP_ANALYTICS_API_URL` environment variable if not set, then to the default `https://api.posthog.com`.
 * @param options.exporters - Configure telemetry exporters to send events to external systems. Available exporters:
 *   - `otlp`: OpenTelemetry Protocol exporter (see {@link ../modules/exporters/otlp.OTLPExporter})
 *   - `datadog`: Datadog APM exporter (see {@link ../modules/exporters/datadog.DatadogExporter})
 *   - `sentry`: Sentry Monitoring exporter (see {@link ../modules/exporters/sentry.SentryExporter})
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
 * import * as mcpAnalytics from "/mcp-analytics";
 *
 * const mcpServer = new Server({ name: "my-mcp-server", version: "1.0.0" });
 *
 * // Track the server with PostHog MCP analytics
 * mcpAnalytics.track(mcpServer, "proj_abc123xyz");
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
 * mcpAnalytics.track(mcpServer, "proj_abc123xyz", {
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
 * mcpAnalytics.track(mcpServer, "proj_abc123xyz", {
 *   enableToolCallContext: true,
 *   customContextDescription: "Explain why you're calling this tool and what business objective it helps achieve"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With sensitive data redaction
 * mcpAnalytics.track(mcpServer, "proj_abc123xyz", {
 *   redactSensitiveInformation: async (text) => {
 *     return text.replace(/api_key_\w+/g, "[REDACTED]");
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With event tags and properties
 * mcpAnalytics.track(mcpServer, "proj_abc123xyz", {
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
 * // Telemetry-only mode (no PostHog MCP analytics account required)
 * mcpAnalytics.track(mcpServer, null, {
 *   exporters: {
 *     otlp: {
 *       type: "otlp",
 *       endpoint: "http://localhost:4318/v1/traces"
 *     }
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Dual mode - send to both PostHog MCP analytics and telemetry exporters
 * mcpAnalytics.track(mcpServer, "proj_abc123xyz", {
 *   exporters: {
 *     datadog: {
 *       type: "datadog",
 *       apiKey: process.env.DD_API_KEY,
 *       site: "datadoghq.com"
 *     }
 *   }
 * });
 * ```
 */
function track(
  server: any,
  projectId: string | null,
  options: MCPAnalyticsOptions = {}
): any {
  try {
    const validatedServer = isCompatibleServerType(server);

    // Resolve API base URL: option > env var > default
    const apiBaseUrl =
      options.apiBaseUrl || process.env.POSTHOG_MCP_ANALYTICS_API_URL;
    if (apiBaseUrl) {
      eventQueue.configure(apiBaseUrl);
    }

    // For high-level servers, we need to pass the underlying server to some functions
    const lowLevelServer = (
      isHighLevelServer(validatedServer)
        ? (validatedServer as any).server
        : validatedServer
    ) as MCPServerLike;

    // Check if server is already being tracked
    const existingData = getServerTrackingData(lowLevelServer);
    if (existingData) {
      writeToLog(
        "[SESSION DEBUG] track() - Server already being tracked, skipping initialization"
      );
      return validatedServer;
    }

    // Initialize telemetry if exporters are configured
    if (options.exporters) {
      const telemetryManager = new TelemetryManager(options.exporters);
      setTelemetryManager(telemetryManager);
      writeToLog(
        `Initialized telemetry with ${Object.keys(options.exporters).length} exporters`
      );
    }

    // If projectId is null and no exporters, warn the user
    if (!(projectId || options.exporters)) {
      writeToLog(
        "Warning: No projectId provided and no exporters configured. Events will not be sent anywhere."
      );
    }

    const sessionInfo = getSessionInfo(lowLevelServer, undefined);
    const mcpAnalyticsData: MCPAnalyticsData = {
      projectId: projectId || "", // Use empty string for null projectId
      sessionId: newSessionId(),
      lastActivity: new Date(),
      identifiedSessions: new Map<string, UserIdentity>(),
      sessionInfo,
      options: {
        enableReportMissing: options.enableReportMissing ?? true,
        enableTracing: options.enableTracing ?? true,
        enableToolCallContext: options.enableToolCallContext ?? true,
        customContextDescription: options.customContextDescription,
        identify: options.identify,
        redactSensitiveInformation: options.redactSensitiveInformation,
        eventTags: options.eventTags,
        eventProperties: options.eventProperties,
      },
      sessionSource: "generated", // Changes to "mcp" if MCP sessionId is provided in requests
    };

    setServerTrackingData(lowLevelServer, mcpAnalyticsData);
    if (isHighLevelServer(validatedServer)) {
      const highLevelServer = validatedServer as HighLevelMCPServerLike;
      setupTracking(highLevelServer);
    } else {
      if (mcpAnalyticsData.options.enableReportMissing) {
        try {
          setupMCPAnalyticsTools(lowLevelServer);
        } catch (error) {
          writeToLog(`Warning: Failed to setup report missing tool - ${error}`);
        }
      }

      if (mcpAnalyticsData.options.enableTracing) {
        try {
          // Pass the low-level server to the current tracing module
          setupToolCallTracing(lowLevelServer);
        } catch (error) {
          writeToLog(`Warning: Failed to setup tool call tracing - ${error}`);
        }
      }
    }

    return validatedServer;
  } catch (error) {
    writeToLog(`Warning: Failed to track server - ${error}`);
    return server;
  }
}

/**
 * Publishes a custom event to PostHog MCP analytics with flexible session management.
 *
 * @param serverOrSessionId - Either a tracked MCP server instance or a MCP session ID string
 * @param projectId - Your PostHog MCP analytics project ID (required)
 * @param eventData - Optional event data to include with the custom event
 *
 * @returns Promise that resolves when the event is queued for publishing
 *
 * @example
 * ```typescript
 * // With a tracked server
 * await mcpAnalytics.publishCustomEvent(
 *   server,
 *   "proj_abc123xyz",
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
 * await mcpAnalytics.publishCustomEvent(
 *   "user-session-12345",
 *   "proj_abc123xyz",
 *   {
 *     isError: true,
 *     error: { message: "Custom error occurred", code: "ERR_001" }
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * await mcpAnalytics.publishCustomEvent(
 *   server,
 *   "proj_abc123xyz",
 *   {
 *     resourceName: "feature-usage",
 *   }
 * );
 * ```
 */
export async function publishCustomEvent(
  serverOrSessionId: any | string,
  projectId: string,
  eventData?: CustomEventData
): Promise<void> {
  // Validate required parameters
  if (!projectId) {
    throw new Error("projectId is required for publishCustomEvent");
  }

  let sessionId: string;

  // Determine if the first parameter is a tracked server or a session ID string
  const isServer =
    typeof serverOrSessionId === "object" && serverOrSessionId !== null;
  let lowLevelServer: MCPServerLike | null = null;

  if (isServer) {
    // Try to get tracking data for the server
    lowLevelServer = serverOrSessionId.server
      ? serverOrSessionId.server
      : serverOrSessionId;
    const trackingData = getServerTrackingData(lowLevelServer as MCPServerLike);

    if (trackingData) {
      // Use the tracked server's session ID and configuration
      sessionId = trackingData.sessionId;
    } else {
      // Server is not tracked - treat it as an error
      throw new Error(
        "Server is not tracked. Please call mcpAnalytics.track() first or provide a session ID string."
      );
    }
  } else if (typeof serverOrSessionId === "string") {
    // Custom session ID provided - derive a deterministic session ID
    sessionId = deriveSessionIdFromMCPSession(serverOrSessionId, projectId);
  } else {
    throw new Error(
      "First parameter must be either an MCP server object or a session ID string"
    );
  }

  // Build the event object
  const event: UnredactedEvent = {
    // Core fields
    sessionId,
    projectId,

    // Fixed event type for custom events
    eventType: MCPAnalyticsEventType.custom,

    // Timestamp
    timestamp: new Date(),

    // Event data from parameters
    resourceName: eventData?.resourceName,
    parameters: eventData?.parameters,
    response: eventData?.response,
    userIntent: eventData?.message,
    duration: eventData?.duration,
    isError: eventData?.isError,
    error: eventData?.error,
  };

  // Wire up customer-defined metadata
  if (eventData?.tags) {
    event.tags = validateTags(eventData.tags);
  }
  if (eventData?.properties && Object.keys(eventData.properties).length > 0) {
    event.properties = eventData.properties;
  }

  // If we have a tracked server, use the publishEvent function
  // Otherwise, add directly to the event queue
  if (lowLevelServer && getServerTrackingData(lowLevelServer)) {
    publishEventToQueue(lowLevelServer, event);
  } else {
    // For custom sessions, we need to import and use the event queue directly
    eventQueue.add(event);
  }

  writeToLog(
    `Published custom event for session ${sessionId} with type '${MCPAnalyticsEventType.custom}'`
  );
}

export type {
  CustomEventData,
  Exporter,
  ExporterConfig,
  MCPAnalyticsOptions,
  RedactFunction,
  UserIdentity,
} from "./types.js";

export type IdentifyFunction = MCPAnalyticsOptions["identify"];

export { track };
