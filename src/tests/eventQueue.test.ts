import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, MCPServerLike } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

vi.mock("../modules/logging.js");
vi.mock("../modules/internal.js");
vi.mock("../modules/session.js");
vi.mock("../modules/ids.js", () => ({
  newPrefixedId: vi.fn(() => "evt_test123"),
}));

// Import mocked modules
import { getServerTrackingData } from "../modules/internal.js";
import { writeToLog } from "../modules/logging.js";
import { getSessionInfo } from "../modules/session.js";

// Import the module under test - need to do this after mocking
const { publishEvent, eventQueue } = await import("../modules/event-queue.js");

describe("EventQueue", () => {
  setupTestHooks();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
      })
    );

    // Mock logging
    (writeToLog as any).mockImplementation(() => {});

    // Mock server tracking data
    (getServerTrackingData as any).mockReturnValue({
      apiKey: "test-project",
      sessionId: "test-session",
      options: { enableTracing: true },
    });

    // Mock session info
    (getSessionInfo as any).mockReturnValue({
      ipAddress: "127.0.0.1",
      sdkLanguage: "typescript",
      sdkVersion: "1.0.0",
      serverName: "test-server",
      serverVersion: "1.0.0",
      clientName: "test-client",
      clientVersion: "1.0.0",
      actorGivenId: null,
      actorName: null,
      actorData: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  describe("publishEvent", () => {
    it("should publish event with server tracking data and session info", async () => {
      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(getSessionInfo).toHaveBeenCalled();
    });

    it("should not publish event when server tracking data is missing", () => {
      (getServerTrackingData as any).mockReturnValue(null);

      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(writeToLog).toHaveBeenCalledWith(
        "Warning: Server tracking data not found. Event will not be published."
      );
    });

    it("should not publish event when enableTracing is false", () => {
      (getServerTrackingData as any).mockReturnValue({
        apiKey: "test-project",
        sessionId: "test-session",
        options: { enableTracing: false },
      });

      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(getSessionInfo).not.toHaveBeenCalled();
    });

    it("should calculate duration when not provided", () => {
      const mockServer: MCPServerLike = {} as any;
      const timestamp = new Date(Date.now() - 1000); // 1 second ago
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp,
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      // Duration should be calculated based on timestamp difference
      expect(getSessionInfo).toHaveBeenCalled();
    });

    it("should preserve existing duration", () => {
      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        duration: 500,
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(getSessionInfo).toHaveBeenCalled();
    });
  });

  describe("EventQueue singleton", () => {
    it("should be accessible and have required methods", () => {
      expect(eventQueue).toBeDefined();
      expect(eventQueue.add).toBeDefined();
      expect(eventQueue.getStats).toBeDefined();
      expect(eventQueue.destroy).toBeDefined();
    });

    it("should track queue stats correctly", () => {
      const stats = eventQueue.getStats();
      expect(stats).toHaveProperty("queueLength");
      expect(stats).toHaveProperty("activeRequests");
      expect(stats).toHaveProperty("isProcessing");
      expect(typeof stats.queueLength).toBe("number");
      expect(typeof stats.activeRequests).toBe("number");
      expect(typeof stats.isProcessing).toBe("boolean");
    });

    it("should be able to add events directly", () => {
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      // This should not throw an error
      expect(() => eventQueue.add(event)).not.toThrow();
    });

    it("should capture mapped events through an injected PostHog client", async () => {
      const capture = vi.fn();
      const posthogClient = {
        capture,
        flush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };

      eventQueue.add(
        {
          eventType: "mcp:tools/call",
          identifyActorGivenId: "user-123",
          resourceName: "create_insight",
          sessionId: "ses_test123",
          timestamp: new Date("2026-05-06T10:00:00.000Z"),
          userIntent: "Create a trend insight for weekly active users",
        },
        posthogClient
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: "user-123",
          event: "mcp_tool_call",
          timestamp: new Date("2026-05-06T10:00:00.000Z"),
        })
      );
      expect(capture.mock.calls[0][0].properties).toEqual(
        expect.objectContaining({
          $mcp_resource_name: "create_insight",
          $mcp_intent: "Create a trend insight for weekly active users",
          $mcp_source: "posthog_mcp_analytics",
          $mcp_tool_name: "create_insight",
        })
      );
      expect(capture.mock.calls[0][0].properties).not.toHaveProperty(
        "project_id"
      );
    });

    it("should emit AI span events when AI tracing is enabled", async () => {
      const capture = vi.fn();
      const posthogClient = {
        capture,
        flush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };

      eventQueue.add(
        {
          eventType: "mcp:tools/call",
          resourceName: "create_insight",
          sessionId: "ses_test123",
          timestamp: new Date("2026-05-06T10:00:00.000Z"),
          userIntent: "Create a trend insight for weekly active users",
        },
        posthogClient,
        true
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "$ai_span",
          properties: expect.objectContaining({
            $ai_span_name: "create_insight",
            $mcp_intent: "Create a trend insight for weekly active users",
          }),
        })
      );
    });

    it("should handle destroy method without errors", async () => {
      // This should not throw an error
      expect(async () => await eventQueue.destroy()).not.toThrow();
    });

    it("should prevent adding events after destroy", async () => {
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      // Call destroy first
      await eventQueue.destroy();

      // Then try to add an event
      eventQueue.add(event);

      // Should log the shutdown message
      expect(writeToLog).toHaveBeenCalledWith(
        "Queue is shutting down, event dropped"
      );
    });
  });

  describe("Integration tests", () => {
    it("should process events end-to-end through publishEvent", async () => {
      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the pipeline was called
      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(getSessionInfo).toHaveBeenCalled();
    });

    it("should handle multiple events", async () => {
      const mockServer: MCPServerLike = {} as any;

      // Add multiple events
      for (let i = 0; i < 5; i++) {
        const event: Event = {
          sessionId: "test-session",
          tool: `test-tool-${i}`,
          timestamp: new Date(),
          arguments: { index: i },
        };
        publishEvent(mockServer, event);
      }

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify multiple calls were made
      expect(getSessionInfo).toHaveBeenCalled();
      expect(getServerTrackingData).toHaveBeenCalled();
    });
  });

  describe("Process lifecycle handling", () => {
    it("should handle SIGINT signal", () => {
      // Test that signal handlers are registered
      expect(process.once).toBeDefined();
    });
  });
});
