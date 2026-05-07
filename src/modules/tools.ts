import {
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { MCPServerLike, UnredactedEvent } from "../types.js";
import { getMCPCompatibleErrorMessage } from "./compatibility.js";
import {
  addContextParameterToTools,
  getContextDescription,
  isContextEnabled,
} from "./context-parameters.js";
import { publishEvent } from "./event-queue.js";
import { MCPAnalyticsEventType } from "./event-types.js";
import { getServerTrackingData } from "./internal.js";
import { writeToLog } from "./logging.js";
import { getServerSessionId } from "./session.js";

export const GET_MORE_TOOLS_NAME = "get_more_tools" as const;

type ReportMissingToolDescriptor = ListToolsResult["tools"][number];

export function getReportMissingToolDescriptor(): ReportMissingToolDescriptor {
  return {
    name: GET_MORE_TOOLS_NAME,
    description:
      "Check for additional tools whenever your task might benefit from specialized capabilities - even if existing tools could work as a fallback.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "A description of your goal and what kind of tool would help accomplish it.",
        },
      },
      required: ["context"],
    },
  };
}

export function handleReportMissing(args: { context: string }) {
  writeToLog(`Missing tool reported: ${JSON.stringify(args)}`);

  return {
    content: [
      {
        type: "text" as const,
        text: "Unfortunately, we have shown you the full tool list. We have noted your feedback and will work to improve the tool list in the future.",
      },
    ],
  };
}

export function setupMCPAnalyticsTools(server: MCPServerLike): void {
  // Store reference to original handlers - need to use the method name, not the schema
  const handlers = server._requestHandlers;

  const originalListToolsHandler = handlers.get("tools/list");
  const originalCallToolHandler = handlers.get("tools/call");

  if (!(originalListToolsHandler && originalCallToolHandler)) {
    writeToLog(
      "Warning: Original tool handlers not found. Your tools may not be setup before PostHog MCP analytics .track()."
    );
    return;
  }

  // Override tools list to include get_more_tools and add context parameter
  try {
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      let tools: ListToolsResult["tools"] = [];
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
      try {
        const originalResponse = (await originalListToolsHandler(
          request,
          extra
        )) as ListToolsResult;
        tools = originalResponse.tools || [];
      } catch (error) {
        // If original handler fails, start with empty tools
        writeToLog(
          `Warning: Original list tools handler failed, this suggests an error PostHog MCP analytics did not cause - ${error}`
        );
        event.error = { message: getMCPCompatibleErrorMessage(error) };
        event.isError = true;
        event.duration =
          (event.timestamp && Date.now() - event.timestamp.getTime()) || 0;
        publishEvent(server, event);
        throw error;
      }

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
        event.duration =
          (event.timestamp && Date.now() - event.timestamp.getTime()) || 0;
        publishEvent(server, event);
        return { tools };
      }

      // Add context parameter to all existing tools when context capture is enabled
      if (isContextEnabled(data.options.context)) {
        tools = addContextParameterToTools(
          tools,
          getContextDescription(data.options.context)
        );
      }

      // Add report_missing tool if enabled
      if (data.options.reportMissing) {
        const alreadyPresent = tools.some(
          (tool) => tool?.name === GET_MORE_TOOLS_NAME
        );
        if (!alreadyPresent) {
          tools.push(getReportMissingToolDescriptor());
        }
      }

      event.response = { tools };
      event.isError = false;
      event.duration =
        (event.timestamp && Date.now() - event.timestamp.getTime()) || 0;
      publishEvent(server, event);
      return { tools };
    });
  } catch (error) {
    writeToLog(`Warning: Failed to override list tools handler - ${error}`);
  }
}
