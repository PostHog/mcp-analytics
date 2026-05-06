import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CompatibleRequestHandlerExtra,
  HighLevelMCPServerLike,
  MCPServerLike,
  RegisteredTool,
  UnredactedEvent,
} from "../types.js";
import { isContextEnabled } from "./context-parameters.js";
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
import {
  createWrappedTool,
  getLiteralValue,
  getObjectShape,
  getToolFunction,
  hasToolFunction,
} from "./mcp-sdk-compat.js";
import { getServerSessionId } from "./session.js";
import { handleReportMissing } from "./tools.js";
import { setupInitializeTracing, setupListToolsTracing } from "./tracing.js";

type MCPRequestHandler = NonNullable<
  MCPServerLike["_requestHandlers"] extends Map<string, infer THandler>
    ? THandler
    : never
>;
type MCPRequest = Parameters<MCPRequestHandler>[0];
type MCPRequestExtra = Parameters<MCPRequestHandler>[1];

// WeakMap to track which callbacks have already been wrapped
const wrappedCallbacks = new WeakMap<object, boolean>();

// Symbol to mark tools that have already been processed
const MCP_ANALYTICS_PROCESSED = Symbol("__posthog_mcp_analytics_processed__");

type ProcessedRegisteredTool = RegisteredTool & {
  [MCP_ANALYTICS_PROCESSED]?: boolean;
};

function isToolResultError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    "isError" in result &&
    result.isError === true
  );
}

function isCallbackUpdate(value: unknown): value is { callback: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    "callback" in value &&
    typeof value.callback === "function"
  );
}

function addTracingToToolRegistry(
  tools: Record<string, RegisteredTool>,
  server: HighLevelMCPServerLike
): Record<string, RegisteredTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      addTracingToToolCallbackInternal(tool, name, server),
    ])
  );
}

function setupListenerToRegisteredTools(server: HighLevelMCPServerLike): void {
  try {
    const data = getServerTrackingData(server.server as MCPServerLike);
    if (!data) {
      writeToLog("Warning: Cannot setup listener - no tracking data found");
      return;
    }

    // Create a proxy handler for the _registeredTools object
    const handler: ProxyHandler<Record<string, RegisteredTool>> = {
      set(
        target: Record<string, RegisteredTool>,
        property: string | symbol,
        value: RegisteredTool
      ): boolean {
        try {
          // Check if this is a tool being registered (has callback or handler property)
          if (
            typeof property === "string" &&
            value &&
            typeof value === "object" &&
            hasToolFunction(value)
          ) {
            // Check if tool has already been processed
            if ((value as ProcessedRegisteredTool)[MCP_ANALYTICS_PROCESSED]) {
              writeToLog(
                `Tool ${String(property)} already processed, skipping proxy wrapping`
              );
              // Just set the value without processing
              return Reflect.set(target, property, value);
            }

            // Check if callback/handler is already wrapped
            if (wrappedCallbacks.has(getToolFunction(value))) {
              writeToLog(
                `Tool ${String(property)} callback already wrapped, skipping proxy wrapping`
              );
              // Just set the value without processing
              return Reflect.set(target, property, value);
            }

            // Apply tracing to the callback (context injection happens in setupListToolsTracing)
            const nextValue = addTracingToToolCallbackInternal(
              value,
              property,
              server
            );

            // After adding a tool, try to set up list tools tracing
            // This handles the case where track() is called before tools are registered
            setupListToolsTracing(server);

            // If the tool has an update method, wrap it to handle callback updates
            if (typeof nextValue.update === "function") {
              const originalUpdate = nextValue.update;
              nextValue.update = function (...updateArgs: unknown[]) {
                // If callback is being updated, wrap the new callback
                // Note: MCP SDK's update() method API uses "callback" property in its interface
                if (updateArgs[0]) {
                  const updateObj = updateArgs[0];
                  if (isCallbackUpdate(updateObj)) {
                    const wrappedTool = addTracingToToolCallbackInternal(
                      { callback: updateObj.callback } as RegisteredTool,
                      property,
                      server
                    );
                    updateObj.callback = getToolFunction(wrappedTool);
                  }
                }
                return originalUpdate.apply(this, updateArgs);
              };
            }
            return Reflect.set(target, property, nextValue);
          }

          // Use Reflect to perform the actual property set
          return Reflect.set(target, property, value);
        } catch (error) {
          writeToLog(
            `Warning: Error in proxy set handler for tool ${String(property)} - ${error}`
          );
          // Fall back to default behavior on error
          return Reflect.set(target, property, value);
        }
      },

      get(
        target: Record<string, RegisteredTool>,
        property: string | symbol
      ): unknown {
        return Reflect.get(target, property);
      },

      deleteProperty(
        target: Record<string, RegisteredTool>,
        property: string | symbol
      ): boolean {
        return Reflect.deleteProperty(target, property);
      },

      has(
        target: Record<string, RegisteredTool>,
        property: string | symbol
      ): boolean {
        return Reflect.has(target, property);
      },
    };

    // Replace _registeredTools with a proxied version
    const originalTools = server._registeredTools || {};
    server._registeredTools = new Proxy(originalTools, handler);

    writeToLog("Successfully set up listener for new tool registrations");
  } catch (error) {
    writeToLog(
      `Warning: Failed to setup listener for registered tools - ${error}`
    );
  }
}

function addTracingToToolCallbackInternal(
  tool: RegisteredTool,
  toolName: string,
  _server: HighLevelMCPServerLike
): RegisteredTool {
  const originalCallback = getToolFunction(tool);

  if (wrappedCallbacks.has(originalCallback)) {
    writeToLog(`Tool ${toolName} callback already wrapped, skipping re-wrap`);
    return tool;
  }

  if ((tool as ProcessedRegisteredTool)[MCP_ANALYTICS_PROCESSED]) {
    writeToLog(`Tool ${toolName} already processed, skipping re-wrap`);
    return tool;
  }

  const wrappedCallback = async (
    ...params: unknown[]
  ): Promise<CallToolResult> => {
    let args: unknown;
    let extra: CompatibleRequestHandlerExtra;

    if (params.length === 2) {
      args = params[0];
      extra = params[1] as CompatibleRequestHandlerExtra;
    } else {
      args = undefined;
      extra = params[0] as CompatibleRequestHandlerExtra;
    }

    const removeContextFromArgs = (args: unknown): unknown => {
      if (args && typeof args === "object" && "context" in args) {
        const { context: _context, ...argsWithoutContext } = args;
        return argsWithoutContext;
      }
      return args;
    };

    const cleanedArgs =
      toolName === "get_more_tools" ? args : removeContextFromArgs(args);

    try {
      if (cleanedArgs === undefined) {
        const handler = originalCallback as (
          extra: CompatibleRequestHandlerExtra
        ) => Promise<CallToolResult>;
        return await handler(extra);
      }
      const handler = originalCallback as (
        args: unknown,
        extra: CompatibleRequestHandlerExtra
      ) => Promise<CallToolResult>;
      return await handler(cleanedArgs, extra);
    } catch (error) {
      if (error instanceof Error) {
        extra.__mcp_analytics_error = error;
      }
      throw error;
    }
  };

  // Mark the original callback as wrapped
  wrappedCallbacks.set(originalCallback, true);

  // Mark the wrapped callback as well (in case it gets re-wrapped)
  wrappedCallbacks.set(wrappedCallback, true);

  // Create a new tool object with the wrapped callback, preserving the property name
  const wrappedTool = createWrappedTool(tool, wrappedCallback);

  // Mark the tool as processed
  (wrappedTool as ProcessedRegisteredTool)[MCP_ANALYTICS_PROCESSED] = true;

  return wrappedTool;
}

function setupToolsCallHandlerWrapping(server: HighLevelMCPServerLike): void {
  const lowLevelServer = server.server as MCPServerLike;

  // Check if tools/call handler already exists
  const existingHandler = lowLevelServer._requestHandlers.get("tools/call");
  if (existingHandler) {
    const wrappedHandler = createToolsCallWrapper(
      existingHandler,
      lowLevelServer
    );
    lowLevelServer._requestHandlers.set("tools/call", wrappedHandler);
  }

  // Intercept future calls to setRequestHandler for tools registered after track()
  const originalSetRequestHandler =
    lowLevelServer.setRequestHandler.bind(lowLevelServer);

  lowLevelServer.setRequestHandler = ((
    requestSchema: unknown,
    handler: MCPRequestHandler
  ) => {
    const shape = getObjectShape(requestSchema);
    const method = shape?.method ? getLiteralValue(shape.method) : undefined;

    // Only wrap tools/call handler
    if (method === "tools/call") {
      const wrappedHandler = createToolsCallWrapper(handler, lowLevelServer);
      return originalSetRequestHandler(requestSchema, wrappedHandler);
    }

    // Pass through all other handlers unchanged
    return originalSetRequestHandler(requestSchema, handler);
  }) as MCPServerLike["setRequestHandler"];
}

function createToolsCallWrapper(
  originalHandler: MCPRequestHandler,
  server: MCPServerLike
): MCPRequestHandler {
  return async (request: MCPRequest, extra: MCPRequestExtra) =>
    await handleWrappedToolsCall(originalHandler, server, request, extra);
}

async function handleWrappedToolsCall(
  originalHandler: MCPRequestHandler,
  server: MCPServerLike,
  request: MCPRequest,
  extra: MCPRequestExtra
): Promise<unknown> {
  const startTime = new Date();
  const tracing = await initializeToolCallEvent(
    server,
    request,
    extra,
    startTime
  );

  if (request?.params?.name === "get_more_tools") {
    return await executeReportMissingTool(server, request, tracing, startTime);
  }

  return await executeOriginalTool(
    originalHandler,
    server,
    request,
    extra,
    tracing,
    startTime
  );
}

async function initializeToolCallEvent(
  server: MCPServerLike,
  request: MCPRequest,
  extra: MCPRequestExtra,
  startTime: Date
): Promise<{ event: UnredactedEvent | null; shouldPublishEvent: boolean }> {
  try {
    const data = getServerTrackingData(server);
    if (!data) {
      writeToLog(
        "Warning: PostHog MCP analytics is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls."
      );
      return { event: null, shouldPublishEvent: false };
    }

    const event: UnredactedEvent = {
      sessionId: getServerSessionId(server, extra),
      resourceName: request.params?.name || "Unknown Tool",
      parameters: { request, extra },
      eventType: MCPAnalyticsEventType.mcpToolsCall,
      timestamp: startTime,
      redactionFn: data.options.redactSensitiveInformation,
    };

    await handleIdentify(server, data, request, extra);
    event.sessionId = data.sessionId;
    await applyResolvedMetadata(event, data, request, extra);

    if (
      isContextEnabled(data.options.context) &&
      request.params?.arguments?.context
    ) {
      event.userIntent = request.params.arguments.context;
    }

    return { event, shouldPublishEvent: true };
  } catch (error) {
    writeToLog(
      `Warning: PostHog MCP analytics tracing failed for tool ${request.params?.name}, falling back to original handler - ${error}`
    );
    return { event: null, shouldPublishEvent: false };
  }
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

async function executeReportMissingTool(
  server: MCPServerLike,
  request: MCPRequest,
  tracing: { event: UnredactedEvent | null; shouldPublishEvent: boolean },
  startTime: Date
): Promise<unknown> {
  try {
    const result = await handleReportMissing({
      context: request?.params?.arguments?.context,
    });
    publishSuccessfulToolEvent(server, tracing, result, startTime, {
      userIntent: request?.params?.arguments?.context,
    });
    return result;
  } catch (error) {
    publishFailedToolEvent(server, tracing, error, startTime);
    throw error;
  }
}

async function executeOriginalTool(
  originalHandler: MCPRequestHandler,
  server: MCPServerLike,
  request: MCPRequest,
  extra: MCPRequestExtra,
  tracing: { event: UnredactedEvent | null; shouldPublishEvent: boolean },
  startTime: Date
): Promise<unknown> {
  try {
    const result = await originalHandler(request, extra);
    publishSuccessfulToolEvent(server, tracing, result, startTime, {
      capturedError: extra?.__mcp_analytics_error,
      clearCapturedError: () => {
        if (extra) {
          extra.__mcp_analytics_error = undefined;
        }
      },
    });
    return result;
  } catch (error) {
    publishFailedToolEvent(server, tracing, error, startTime);
    throw error;
  }
}

function publishSuccessfulToolEvent(
  server: MCPServerLike,
  tracing: { event: UnredactedEvent | null; shouldPublishEvent: boolean },
  result: unknown,
  startTime: Date,
  options: {
    capturedError?: unknown;
    clearCapturedError?: () => void;
    userIntent?: string;
  } = {}
): void {
  if (!(tracing.event && tracing.shouldPublishEvent)) {
    return;
  }

  if (options.userIntent) {
    tracing.event.userIntent = options.userIntent;
  }
  if (isToolResultError(result)) {
    tracing.event.isError = true;
    tracing.event.error = captureException(options.capturedError || result);
    options.clearCapturedError?.();
  }

  tracing.event.response = result;
  tracing.event.duration = Date.now() - startTime.getTime();
  publishEvent(server, tracing.event);
}

function publishFailedToolEvent(
  server: MCPServerLike,
  tracing: { event: UnredactedEvent | null; shouldPublishEvent: boolean },
  error: unknown,
  startTime: Date
): void {
  if (!(tracing.event && tracing.shouldPublishEvent)) {
    return;
  }

  tracing.event.isError = true;
  tracing.event.error = captureException(error);
  tracing.event.duration = Date.now() - startTime.getTime();
  publishEvent(server, tracing.event);
}

export function setupTracking(server: HighLevelMCPServerLike): void {
  try {
    const _mcpAnalyticsData = getServerTrackingData(server.server);

    // Setup handler wrapping before any tools are registered
    setupToolsCallHandlerWrapping(server);

    setupInitializeTracing(server);

    // Modify existing callbacks to include tracing and publishing events
    // This now includes get_more_tools if it was added
    server._registeredTools = addTracingToToolRegistry(
      server._registeredTools,
      server
    );

    setupListToolsTracing(server);

    // Proxy the high level server's registered tools to ensure new tools are injected with tracing
    // Note: Context parameter injection now happens in setupListToolsTracing (after JSON Schema conversion)
    setupListenerToRegisteredTools(server);
  } catch (error) {
    writeToLog(`Warning: Failed to setup tool call tracing - ${error}`);
  }
}
