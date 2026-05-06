import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  HighLevelMCPServerLike,
  MCPServerLike,
  UnredactedEvent,
} from "../types.js";
import { getMCPCompatibleErrorMessage } from "./compatibility.js";
import { addContextParameterToTools } from "./context-parameters.js";
import { publishEvent } from "./event-queue.js";
import { MCPAnalyticsEventType } from "./event-types.js";
import { captureException } from "./exceptions.js";
import {
  getServerTrackingData,
  handleIdentify,
  resolveEventProperties,
  resolveEventTags,
} from "./internal.js";
import { writeToLog } from "./logging.js";
import { getServerSessionId } from "./session.js";
import {
  GET_MORE_TOOLS_NAME,
  getReportMissingToolDescriptor,
  handleReportMissing,
} from "./tools.js";

type MCPRequestHandler = NonNullable<
  MCPServerLike["_requestHandlers"] extends Map<string, infer THandler>
    ? THandler
    : never
>;
type MCPRequest = Parameters<MCPRequestHandler>[0];
type MCPRequestExtra = Parameters<MCPRequestHandler>[1];
type MCPServerWithCapabilities = MCPServerLike & {
  _capabilities?: {
    tools?: unknown;
  };
};

function isToolResultError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    "isError" in result &&
    result.isError === true
  );
}

// Track if we've already set up list tools tracing per server instance
const listToolsTracingSetup = new WeakMap<MCPServerLike, boolean>();

export function setupListToolsTracing(
  highLevelServer: HighLevelMCPServerLike
): void {
  const server = highLevelServer.server;

  // Check if server supports tools capability
  if (!(server as MCPServerWithCapabilities)._capabilities?.tools) {
    // Server doesn't support tools yet, skip setup
    return;
  }

  // Check if we've already set up tracing for this server instance
  if (listToolsTracingSetup.get(server)) {
    return;
  }

  const handlers = server._requestHandlers;
  const originalListToolsHandler = handlers.get("tools/list");

  // No handler to override yet
  if (!originalListToolsHandler) {
    return;
  }

  try {
    server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra) =>
        await handleListToolsRequest(
          server,
          originalListToolsHandler,
          request,
          extra
        )
    );

    // Mark as setup successful for this server instance
    listToolsTracingSetup.set(server, true);
  } catch (error) {
    writeToLog(`Warning: Failed to override list tools handler - ${error}`);
  }
}

async function handleListToolsRequest(
  server: MCPServerLike,
  originalListToolsHandler: MCPRequestHandler,
  request: MCPRequest,
  extra: MCPRequestExtra
): Promise<{ tools: ListToolsResult["tools"] }> {
  const data = getServerTrackingData(server);
  const event: UnredactedEvent = {
    sessionId: getServerSessionId(server, extra),
    parameters: {
      request,
      extra,
    },
    eventType: MCPAnalyticsEventType.mcpToolsList,
    timestamp: new Date(),
    redactionFn: data?.options.redactSensitiveInformation,
  };

  if (data) {
    await applyResolvedMetadata(event, data, request, extra);
  }

  const tools = await getTracedToolsList(
    server,
    originalListToolsHandler,
    request,
    extra,
    event
  );

  if (!data) {
    writeToLog(
      "Warning: PostHog MCP analytics is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls."
    );
    return { tools };
  }

  if (tools.length === 0) {
    writeToLog(
      "Warning: No tools found in the original list. This is likely due to the tools not being registered before PostHog MCP analytics.track()."
    );
    event.error = { message: "No tools were sent to MCP client." };
    event.isError = true;
    event.duration = getEventDuration(event);
    publishEvent(server, event);
    return { tools };
  }

  event.response = { tools };
  event.isError = false;
  event.duration = getEventDuration(event);
  publishEvent(server, event);
  return { tools };
}

async function getTracedToolsList(
  server: MCPServerLike,
  originalListToolsHandler: MCPRequestHandler,
  request: MCPRequest,
  extra: MCPRequestExtra,
  event: UnredactedEvent
): Promise<ListToolsResult["tools"]> {
  try {
    const data = getServerTrackingData(server);
    const originalResponse = (await originalListToolsHandler(
      request,
      extra
    )) as ListToolsResult;
    let tools = originalResponse.tools || [];

    if (data?.options.enableToolCallContext) {
      tools = addContextParameterToTools(
        tools,
        data.options.customContextDescription
      );
    }

    if (data?.options.enableReportMissing) {
      const alreadyPresent = tools.some(
        (tool) => tool?.name === GET_MORE_TOOLS_NAME
      );
      if (!alreadyPresent) {
        tools.push(getReportMissingToolDescriptor());
      }
    }
    return tools;
  } catch (error) {
    writeToLog(
      `Warning: Original list tools handler failed, this suggests an error PostHog MCP analytics did not cause - ${error}`
    );
    event.error = { message: getMCPCompatibleErrorMessage(error) };
    event.isError = true;
    event.duration = getEventDuration(event);
    publishEvent(server, event);
    throw error;
  }
}

export function setupInitializeTracing(
  highLevelServer: HighLevelMCPServerLike
): void {
  const server = highLevelServer.server;
  const handlers = server._requestHandlers;
  const originalInitializeHandler = handlers.get("initialize");

  if (originalInitializeHandler) {
    server.setRequestHandler(
      InitializeRequestSchema,
      async (request, extra) => {
        const data = getServerTrackingData(server);
        if (!data) {
          writeToLog(
            "Warning: PostHog MCP analytics is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls."
          );
          return await originalInitializeHandler(request, extra);
        }

        const sessionId = getServerSessionId(server, extra);

        // Try to identify the session
        await handleIdentify(server, data, request, extra);

        const event: UnredactedEvent = {
          sessionId,
          resourceName: request.params?.name || "Unknown Tool Name",
          eventType: MCPAnalyticsEventType.mcpInitialize,
          parameters: {
            request,
            extra,
          },
          timestamp: new Date(),
          redactionFn: data.options.redactSensitiveInformation,
        };

        const resolvedTags = await resolveEventTags(data, request, extra);
        if (resolvedTags) {
          event.tags = resolvedTags;
        }
        const resolvedProperties = await resolveEventProperties(
          data,
          request,
          extra
        );
        if (resolvedProperties) {
          event.properties = resolvedProperties;
        }

        const result = await originalInitializeHandler(request, extra);
        event.response = result;
        publishEvent(server, event);
        return result;
      }
    );
  }
}

export function setupToolCallTracing(server: MCPServerLike): void {
  try {
    const handlers = server._requestHandlers;

    const originalCallToolHandler = handlers.get("tools/call");
    const originalInitializeHandler = handlers.get("initialize");

    if (originalInitializeHandler) {
      server.setRequestHandler(
        InitializeRequestSchema,
        async (request, extra) => {
          const data = getServerTrackingData(server);
          if (!data) {
            writeToLog(
              "Warning: PostHog MCP analytics is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls."
            );
            return await originalInitializeHandler(request, extra);
          }

          const sessionId = getServerSessionId(server, extra);

          // Try to identify the session
          await handleIdentify(server, data, request, extra);

          const event: UnredactedEvent = {
            sessionId,
            resourceName: request.params?.name || "Unknown Tool Name",
            eventType: MCPAnalyticsEventType.mcpInitialize,
            parameters: {
              request,
              extra,
            },
            timestamp: new Date(),
            redactionFn: data.options.redactSensitiveInformation,
          };

          const resolvedTags = await resolveEventTags(data, request, extra);
          if (resolvedTags) {
            event.tags = resolvedTags;
          }
          const resolvedProperties = await resolveEventProperties(
            data,
            request,
            extra
          );
          if (resolvedProperties) {
            event.properties = resolvedProperties;
          }

          const result = await originalInitializeHandler(request, extra);
          event.response = result;
          publishEvent(server, event);
          return result;
        }
      );
    }

    server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) =>
        await handleToolCallRequest(
          server,
          originalCallToolHandler,
          request,
          extra
        )
    );
  } catch (error) {
    writeToLog(`Warning: Failed to setup tool call tracing - ${error}`);
    throw error;
  }
}

async function handleToolCallRequest(
  server: MCPServerLike,
  originalCallToolHandler: MCPRequestHandler | undefined,
  request: MCPRequest,
  extra: MCPRequestExtra
): Promise<unknown> {
  const data = getServerTrackingData(server);
  if (!data) {
    writeToLog(
      "Warning: PostHog MCP analytics is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls."
    );
    return await originalCallToolHandler?.(request, extra);
  }

  const event: UnredactedEvent = {
    sessionId: getServerSessionId(server, extra),
    resourceName: request.params?.name || "Unknown Tool Name",
    parameters: {
      request,
      extra,
    },
    eventType: MCPAnalyticsEventType.mcpToolsCall,
    timestamp: new Date(),
    redactionFn: data.options.redactSensitiveInformation,
  };

  try {
    await handleIdentify(server, data, request, extra);
    await applyResolvedMetadata(event, data, request, extra);
    setToolCallContext(event, data.options.enableToolCallContext, request);

    const result = await executeToolCall(
      server,
      originalCallToolHandler,
      request,
      extra,
      event
    );
    if (isToolResultError(result)) {
      event.isError = true;
      event.error = captureException(result);
    }

    event.response = result;
    publishEvent(server, event);
    return result;
  } catch (error) {
    event.isError = true;
    event.error = captureException(error);
    publishEvent(server, event);
    throw error;
  }
}

async function executeToolCall(
  server: MCPServerLike,
  originalCallToolHandler: MCPRequestHandler | undefined,
  request: MCPRequest,
  extra: MCPRequestExtra,
  event: UnredactedEvent
): Promise<unknown> {
  if (request.params?.name === "get_more_tools") {
    event.userIntent = String(request.params.arguments.context);
    return handleReportMissing(request.params.arguments.context);
  }

  if (originalCallToolHandler) {
    return await originalCallToolHandler(request, extra);
  }

  event.isError = true;
  event.error = {
    message: `Tool call handler not found for ${request.params?.name || "unknown"}`,
  };
  event.duration = getEventDuration(event) || undefined;
  publishEvent(server, event);
  throw new Error(`Unknown tool: ${request.params?.name || "unknown"}`);
}

async function applyResolvedMetadata(
  event: UnredactedEvent,
  data: NonNullable<ReturnType<typeof getServerTrackingData>>,
  request: MCPRequest,
  extra: MCPRequestExtra
): Promise<void> {
  const resolvedTags = await resolveEventTags(data, request, extra);
  if (resolvedTags) {
    event.tags = resolvedTags;
  }
  const resolvedProperties = await resolveEventProperties(data, request, extra);
  if (resolvedProperties) {
    event.properties = resolvedProperties;
  }
}

function setToolCallContext(
  event: UnredactedEvent,
  enableToolCallContext: boolean | undefined,
  request: MCPRequest
): void {
  if (!(enableToolCallContext && request.params?.name !== "get_more_tools")) {
    return;
  }

  const hasContext =
    request.params?.arguments &&
    typeof request.params.arguments === "object" &&
    "context" in request.params.arguments;
  if (hasContext) {
    event.userIntent = request.params.arguments.context;
  }
}

function getEventDuration(event: UnredactedEvent): number {
  return event.timestamp ? Date.now() - event.timestamp.getTime() : 0;
}
