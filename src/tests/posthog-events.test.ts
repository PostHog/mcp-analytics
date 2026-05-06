import { validate as uuidValidate, version as uuidVersion } from "uuid";
import { describe, expect, it } from "vitest";
import { MCPAnalyticsEventType } from "../modules/event-types.js";
import {
  buildPostHogCaptureEvents,
  type PostHogCaptureEvent,
} from "../modules/posthog-events.js";
import KSUID from "../thirdparty/ksuid/index.js";
import type { Event } from "../types.js";

function expectUUIDv7(value: string): void {
  expect(uuidValidate(value)).toBe(true);
  expect(uuidVersion(value)).toBe(7);
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt_test123",
    sessionId: "ses_session456",
    apiKey: "proj_1",
    eventType: MCPAnalyticsEventType.mcpToolsCall,
    timestamp: new Date("2025-01-15T10:00:00Z"),
    resourceName: "get_weather",
    serverName: "weather-server",
    serverVersion: "1.0.0",
    clientName: "claude-desktop",
    clientVersion: "2.0.0",
    duration: 150,
    isError: false,
    ...overrides,
  };
}

function findEvent(
  events: PostHogCaptureEvent[],
  eventName: string
): PostHogCaptureEvent | undefined {
  return events.find((event) => event.event === eventName);
}

describe("buildPostHogCaptureEvents", () => {
  it("builds the regular MCP tool-call event payload", () => {
    const [event] = buildPostHogCaptureEvents(makeEvent());

    expect(event.event).toBe("mcp_tool_call");
    expect(event.type).toBe("capture");
    expect(event.distinct_id).toBe("ses_session456");
    expect(event.timestamp).toBe("2025-01-15T10:00:00.000Z");

    expectUUIDv7(event.properties.$session_id as string);
    expect(event.properties.$mcp_tool_name).toBe("get_weather");
    expect(event.properties.$mcp_resource_name).toBe("get_weather");
    expect(event.properties.$mcp_duration_ms).toBe(150);
    expect(event.properties.$mcp_server_name).toBe("weather-server");
    expect(event.properties.$mcp_server_version).toBe("1.0.0");
    expect(event.properties.$mcp_client_name).toBe("claude-desktop");
    expect(event.properties.$mcp_client_version).toBe("2.0.0");
    expect(event.properties.$mcp_is_error).toBe(false);
    expect(event.properties).not.toHaveProperty("project_id");
  });

  it("uses identifyActorGivenId as distinct_id when available", () => {
    const [event] = buildPostHogCaptureEvents(
      makeEvent({ identifyActorGivenId: "user_abc123" })
    );

    expect(event.distinct_id).toBe("user_abc123");
  });

  it("falls back to sessionId when identifyActorGivenId is not set", () => {
    const [event] = buildPostHogCaptureEvents(
      makeEvent({ identifyActorGivenId: undefined })
    );

    expect(event.distinct_id).toBe("ses_session456");
  });

  it("builds an $exception event alongside the regular event for errors", () => {
    const events = buildPostHogCaptureEvents(
      makeEvent({
        isError: true,
        error: {
          message: "Connection timeout",
          type: "TimeoutError",
          stack:
            "TimeoutError: Connection timeout\n    at fetch (/app/index.js:10:5)",
        },
      })
    );

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("mcp_tool_call");
    expect(events[0].properties.$mcp_is_error).toBe(true);

    const exceptionEvent = events[1];
    expect(exceptionEvent.event).toBe("$exception");
    expect(exceptionEvent.distinct_id).toBe("ses_session456");
    expect(exceptionEvent.properties.$exception_message).toBe(
      "Connection timeout"
    );
    expect(exceptionEvent.properties.$exception_type).toBe("TimeoutError");
    expect(exceptionEvent.properties.$exception_stacktrace).toBe(
      "TimeoutError: Connection timeout\n    at fetch (/app/index.js:10:5)"
    );
    expect(exceptionEvent.properties.$exception_source).toBe("backend");
    expectUUIDv7(exceptionEvent.properties.$session_id as string);
    expect(exceptionEvent.properties.$mcp_resource_name).toBe("get_weather");
    expect(exceptionEvent.properties.$mcp_tool_name).toBe("get_weather");
    expect(exceptionEvent.properties.$mcp_server_name).toBe("weather-server");
  });

  it("does not build an $exception event when isError is false", () => {
    const events = buildPostHogCaptureEvents(makeEvent({ isError: false }));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("mcp_tool_call");
  });

  it("includes $set person properties from identity data", () => {
    const [event] = buildPostHogCaptureEvents(
      makeEvent({
        identifyActorGivenId: "user_abc",
        identifyActorName: "Alice",
        identifyActorData: { email: "alice@example.com", plan: "pro" },
      })
    );

    expect(event.properties.$set).toEqual({
      name: "Alice",
      email: "alice@example.com",
      plan: "pro",
    });
  });

  it("does not include $set when no identity data is present", () => {
    const [event] = buildPostHogCaptureEvents(makeEvent());

    expect(event.properties.$set).toBeUndefined();
  });

  it("passes through parameters and response as-is", () => {
    const [event] = buildPostHogCaptureEvents(
      makeEvent({
        parameters: { city: "London", units: "celsius" },
        response: { temperature: 15, condition: "cloudy" },
      })
    );

    expect(event.properties.$mcp_parameters).toEqual({
      city: "London",
      units: "celsius",
    });
    expect(event.properties.$mcp_response).toEqual({
      temperature: 15,
      condition: "cloudy",
    });
  });

  it("passes through string parameters and response as-is", () => {
    const [event] = buildPostHogCaptureEvents(
      makeEvent({
        parameters: "raw input",
        response: "raw output",
      })
    );

    expect(event.properties.$mcp_parameters).toBe("raw input");
    expect(event.properties.$mcp_response).toBe("raw output");
  });

  it("only sets $mcp_tool_name for tools/call events", () => {
    const [toolCallEvent] = buildPostHogCaptureEvents(
      makeEvent({
        eventType: MCPAnalyticsEventType.mcpToolsCall,
        resourceName: "get_weather",
      })
    );
    expect(toolCallEvent.properties.$mcp_tool_name).toBe("get_weather");
    expect(toolCallEvent.properties.$mcp_resource_name).toBe("get_weather");

    const [resourceEvent] = buildPostHogCaptureEvents(
      makeEvent({
        eventType: MCPAnalyticsEventType.mcpResourcesRead,
        resourceName: "my_resource",
      })
    );
    expect(resourceEvent.properties.$mcp_tool_name).toBeUndefined();
    expect(resourceEvent.properties.$mcp_resource_name).toBe("my_resource");
  });

  it("maps MCP event types to PostHog event names", () => {
    const eventTypes: Record<string, string> = {
      [MCPAnalyticsEventType.mcpToolsCall]: "mcp_tool_call",
      [MCPAnalyticsEventType.mcpToolsList]: "mcp_tools_list",
      [MCPAnalyticsEventType.mcpInitialize]: "mcp_initialize",
      [MCPAnalyticsEventType.mcpResourcesRead]: "mcp_resource_read",
      [MCPAnalyticsEventType.mcpResourcesList]: "mcp_resources_list",
      [MCPAnalyticsEventType.mcpPromptsGet]: "mcp_prompt_get",
      [MCPAnalyticsEventType.mcpPromptsList]: "mcp_prompts_list",
      "mcp:custom/type": "mcp_custom_type",
    };

    for (const [input, expected] of Object.entries(eventTypes)) {
      const [event] = buildPostHogCaptureEvents(
        makeEvent({ eventType: input })
      );

      expect(event.event).toBe(expected);
    }
  });

  it("spreads customer-defined tags and properties directly into properties", () => {
    const [event] = buildPostHogCaptureEvents(
      makeEvent({
        tags: { env: "production", trace_id: "abc-123" },
        properties: { device: "mobile", feature_flags: ["dark_mode"] },
      })
    );

    expect(event.properties.env).toBe("production");
    expect(event.properties.trace_id).toBe("abc-123");
    expect(event.properties.device).toBe("mobile");
    expect(event.properties.feature_flags).toEqual(["dark_mode"]);
  });

  it("does not include customer tag or property keys when not set on event", () => {
    const [event] = buildPostHogCaptureEvents(makeEvent());

    expect(event.properties.$mcp_source).toBe("posthog_mcp_analytics");
    expect(event.properties.env).toBeUndefined();
    expect(event.properties.device).toBeUndefined();
  });

  it("maps userIntent to the MCP intent property", () => {
    const [event] = buildPostHogCaptureEvents(
      makeEvent({ userIntent: "Check the weather in London" })
    );

    expect(event.properties.$mcp_intent).toBe("Check the weather in London");
  });

  it("emits $ai_span alongside regular event for tool calls when enableAITracing is true", () => {
    const events = buildPostHogCaptureEvents(
      makeEvent({
        eventType: MCPAnalyticsEventType.mcpToolsCall,
        resourceName: "get_weather",
        duration: 250,
        parameters: { city: "London" },
        response: { temp: 15 },
      }),
      { enableAITracing: true }
    );

    expect(events).toHaveLength(2);

    const regular = findEvent(events, "mcp_tool_call");
    expect(regular).toBeDefined();

    const span = findEvent(events, "$ai_span");
    expect(span).toBeDefined();
    expect(span?.type).toBe("capture");
    expect(span?.distinct_id).toBe("ses_session456");
    expect(span?.timestamp).toBe("2025-01-15T10:00:00.000Z");

    expect(span?.properties.$ai_session_id).toBe(
      "posthog_mcp_analytics_ses_session456"
    );
    expect(span?.properties.$ai_trace_id).toBeDefined();
    expect(span?.properties.$ai_span_id).toBeDefined();
    expect(span?.properties.$ai_trace_id).not.toBe(
      span?.properties.$ai_span_id
    );
    expect(span?.properties.$ai_span_name).toBe("get_weather");
    expect(span?.properties.$ai_latency).toBeCloseTo(0.25);
    expect(span?.properties.$ai_is_error).toBe(false);
    expect(span?.properties.$ai_input_state).toEqual({ city: "London" });
    expect(span?.properties.$ai_output_state).toEqual({ temp: 15 });
    expectUUIDv7(span?.properties.$session_id as string);
    expect(span?.properties.$mcp_source).toBe("posthog_mcp_analytics");
    expect(span?.properties.$mcp_server_name).toBe("weather-server");
    expect(span?.properties.$mcp_client_name).toBe("claude-desktop");

    expect(regular?.properties.$ai_trace_id).toBe(
      span?.properties.$ai_trace_id
    );
    expect(regular?.properties.$ai_span_id).toBe(span?.properties.$ai_span_id);
  });

  it("generates deterministic UUIDs for $ai_span trace and span IDs", () => {
    const sesId = KSUID.withPrefix("ses").randomSync();
    const evtA = KSUID.withPrefix("evt").randomSync();
    const evtB = KSUID.withPrefix("evt").randomSync();

    const spanA = findEvent(
      buildPostHogCaptureEvents(makeEvent({ id: evtA, sessionId: sesId }), {
        enableAITracing: true,
      }),
      "$ai_span"
    );
    const spanB = findEvent(
      buildPostHogCaptureEvents(makeEvent({ id: evtB, sessionId: sesId }), {
        enableAITracing: true,
      }),
      "$ai_span"
    );
    const spanC = findEvent(
      buildPostHogCaptureEvents(makeEvent({ id: evtA, sessionId: sesId }), {
        enableAITracing: true,
      }),
      "$ai_span"
    );

    expect(spanA?.properties.$ai_session_id).toBe(
      `posthog_mcp_analytics_${sesId}`
    );
    expect(spanA?.properties.$ai_session_id).toBe(
      spanB?.properties.$ai_session_id
    );
    expect(spanA?.properties.$ai_trace_id).toBe(spanB?.properties.$ai_trace_id);
    expect(spanA?.properties.$ai_span_id).not.toBe(
      spanB?.properties.$ai_span_id
    );
    expect(spanA?.properties.$ai_span_id).toBe(spanC?.properties.$ai_span_id);
    expect(spanA?.properties.$ai_trace_id).not.toBe(
      spanA?.properties.$ai_span_id
    );
    expectUUIDv7(spanA?.properties.$ai_trace_id as string);
    expectUUIDv7(spanA?.properties.$ai_span_id as string);
  });

  it("does not emit $ai_span when enableAITracing is false or unset", () => {
    const defaultEvents = buildPostHogCaptureEvents(
      makeEvent({ eventType: MCPAnalyticsEventType.mcpToolsCall })
    );
    expect(defaultEvents).toHaveLength(1);
    expect(defaultEvents[0].event).toBe("mcp_tool_call");

    const disabledEvents = buildPostHogCaptureEvents(
      makeEvent({ eventType: MCPAnalyticsEventType.mcpToolsCall }),
      { enableAITracing: false }
    );
    expect(disabledEvents).toHaveLength(1);
    expect(disabledEvents[0].event).toBe("mcp_tool_call");
  });

  it("does not emit $ai_span for non-tool-call events even with enableAITracing", () => {
    const nonToolCallTypes = [
      MCPAnalyticsEventType.mcpInitialize,
      MCPAnalyticsEventType.mcpToolsList,
      MCPAnalyticsEventType.mcpResourcesRead,
      MCPAnalyticsEventType.mcpResourcesList,
      MCPAnalyticsEventType.mcpPromptsGet,
      MCPAnalyticsEventType.mcpPromptsList,
    ];

    for (const eventType of nonToolCallTypes) {
      const events = buildPostHogCaptureEvents(makeEvent({ eventType }), {
        enableAITracing: true,
      });

      expect(findEvent(events, "$ai_span")).toBeUndefined();
    }
  });

  it("spreads customer tags and properties directly on $ai_span", () => {
    const events = buildPostHogCaptureEvents(
      makeEvent({
        eventType: MCPAnalyticsEventType.mcpToolsCall,
        tags: { env: "production", region: "us-east" },
        properties: { feature_flag: "new_ui", count: 42 },
      }),
      { enableAITracing: true }
    );

    const span = findEvent(events, "$ai_span");
    expect(span?.properties.env).toBe("production");
    expect(span?.properties.region).toBe("us-east");
    expect(span?.properties.feature_flag).toBe("new_ui");
    expect(span?.properties.count).toBe(42);

    const regular = findEvent(events, "mcp_tool_call");
    expect(regular?.properties.env).toBe("production");
    expect(regular?.properties.feature_flag).toBe("new_ui");
    expect(regular?.properties.count).toBe(42);
  });

  it("allows customer tags to override $ai_* defaults on $ai_span", () => {
    const customTraceId = "custom-trace-uuid-from-customer";
    const events = buildPostHogCaptureEvents(
      makeEvent({
        eventType: MCPAnalyticsEventType.mcpToolsCall,
        tags: { $ai_trace_id: customTraceId, $ai_span_name: "custom_name" },
      }),
      { enableAITracing: true }
    );

    const span = findEvent(events, "$ai_span");
    expect(span?.properties.$ai_trace_id).toBe(customTraceId);
    expect(span?.properties.$ai_span_name).toBe("custom_name");
  });

  it("emits regular + $exception + $ai_span for error tool calls with enableAITracing", () => {
    const events = buildPostHogCaptureEvents(
      makeEvent({
        eventType: MCPAnalyticsEventType.mcpToolsCall,
        isError: true,
        error: {
          message: "Tool execution failed",
          type: "ExecutionError",
        },
      }),
      { enableAITracing: true }
    );

    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("mcp_tool_call");
    expect(events[1].event).toBe("$exception");
    expect(events[2].event).toBe("$ai_span");
    expect(events[2].properties.$ai_is_error).toBe(true);
    expect(events[2].properties.$ai_error).toEqual({
      message: "Tool execution failed",
      type: "ExecutionError",
    });
  });
});
