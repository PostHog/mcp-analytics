import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomEventData, MCPServerLike } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

// Mock external dependencies
vi.mock("../modules/logging.js");
vi.mock("../modules/internal.js");
vi.mock("../modules/session.js");
vi.mock("../modules/event-queue.js");

// Import the function under test
import { publishCustomEvent } from "../index.js";
import {
  eventQueue,
  publishEvent as publishEventToQueue,
} from "../modules/event-queue.js";
import { getServerTrackingData } from "../modules/internal.js";
// Import mocked modules
import { writeToLog } from "../modules/logging.js";
import { deriveSessionIdFromMCPSession } from "../modules/session.js";

describe("publishCustomEvent", () => {
  setupTestHooks();

  let mockEventQueue: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock logging
    (writeToLog as any).mockImplementation(() => {});

    // Mock event queue
    mockEventQueue = {
      add: vi.fn(),
    };
    (eventQueue as any).add = mockEventQueue.add;

    // Mock deriveSessionIdFromMCPSession
    (deriveSessionIdFromMCPSession as any).mockImplementation(
      (sessionId: string, apiKey: string) =>
        `ses_derived_${sessionId}_${apiKey}`
    );

    // Mock publishEventToQueue
    (publishEventToQueue as any).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("with tracked server", () => {
    let mockServer: MCPServerLike;

    beforeEach(() => {
      mockServer = {} as any;

      // Mock server tracking data
      (getServerTrackingData as any).mockReturnValue({
        apiKey: "phc_tracked",
        sessionId: "ses_tracked123",
        options: {},
      });
    });

    it("should publish custom event with tracked server", async () => {
      const eventData: CustomEventData = {
        resourceName: "custom-action",
        parameters: { action: "test" },
        message: "Testing custom event",
      };

      await publishCustomEvent(mockServer, eventData);

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          sessionId: "ses_tracked123",
          apiKey: "phc_tracked",
          eventType: "posthog:custom",
          resourceName: "custom-action",
          parameters: { action: "test" },
          userIntent: "Testing custom event", // message maps to userIntent
        })
      );
      expect(writeToLog).toHaveBeenCalledWith(
        expect.stringContaining("Published custom event")
      );
    });

    it("should handle error data correctly", async () => {
      const eventData: CustomEventData = {
        isError: true,
        error: { message: "Test error", code: "ERR_001" },
      };

      await publishCustomEvent(mockServer, eventData);

      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          isError: true,
          error: { message: "Test error", code: "ERR_001" },
        })
      );
    });

    it("should throw error if server is not tracked", async () => {
      (getServerTrackingData as any).mockReturnValue(undefined);

      await expect(publishCustomEvent(mockServer)).rejects.toThrow(
        "Server is not tracked"
      );
    });

    it("should handle high-level server objects", async () => {
      const highLevelServer = {
        server: mockServer,
      };

      await publishCustomEvent(highLevelServer);

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
    });
  });

  describe("with custom session ID", () => {
    const customSessionId = "user-session-12345";
    const apiKey = "phc_test123";

    it("should publish custom event with derived session ID", async () => {
      const eventData: CustomEventData = {
        apiKey,
        resourceName: "custom-action",
        parameters: { action: "test" },
      };

      await publishCustomEvent(customSessionId, eventData);

      expect(deriveSessionIdFromMCPSession).toHaveBeenCalledWith(
        customSessionId,
        apiKey
      );
      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: `ses_derived_${customSessionId}_${apiKey}`,
          apiKey,
          eventType: "posthog:custom",
          resourceName: "custom-action",
          parameters: { action: "test" },
        })
      );
    });

    it("should handle all event data fields", async () => {
      const eventData: CustomEventData = {
        apiKey,
        resourceName: "full-test",
        parameters: { key: "value" },
        response: { result: "success" },
        message: "Complete test",
        duration: 1500,
        isError: false,
        error: null,
      };

      await publishCustomEvent(customSessionId, eventData);

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: "full-test",
          parameters: { key: "value" },
          response: { result: "success" },
          userIntent: "Complete test", // message maps to userIntent
          duration: 1500,
          isError: false,
          error: null,
        })
      );
    });
  });

  describe("parameter validation", () => {
    it("should throw error if apiKey is not provided for a session ID", async () => {
      await expect(publishCustomEvent("session-id")).rejects.toThrow(
        "apiKey or posthogClient is required"
      );

      await expect(publishCustomEvent("session-id", {})).rejects.toThrow(
        "apiKey or posthogClient is required"
      );
    });

    it("should throw error if first parameter is invalid", async () => {
      await expect(publishCustomEvent(123 as any, {})).rejects.toThrow(
        "First parameter must be either an MCP server object or a session ID string"
      );

      await expect(publishCustomEvent(null as any, {})).rejects.toThrow(
        "First parameter must be either an MCP server object or a session ID string"
      );

      await expect(publishCustomEvent(undefined as any, {})).rejects.toThrow(
        "First parameter must be either an MCP server object or a session ID string"
      );
    });
  });

  describe("event structure", () => {
    it("should always use 'posthog:custom' as event type", async () => {
      const customSessionId = "test-session";
      const apiKey = "phc_test";

      await publishCustomEvent(customSessionId, { apiKey });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "posthog:custom",
        })
      );
    });

    it("should include timestamp", async () => {
      const customSessionId = "test-session";
      const apiKey = "phc_test";
      const beforeTime = new Date();

      await publishCustomEvent(customSessionId, { apiKey });

      const afterTime = new Date();

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(Date),
        })
      );

      const calledTimestamp = mockEventQueue.add.mock.calls[0][0].timestamp;
      expect(calledTimestamp.getTime()).toBeGreaterThanOrEqual(
        beforeTime.getTime()
      );
      expect(calledTimestamp.getTime()).toBeLessThanOrEqual(
        afterTime.getTime()
      );
    });

    it("should handle minimal event data gracefully", async () => {
      const customSessionId = "test-session";
      const apiKey = "phc_test";

      await publishCustomEvent(customSessionId, { apiKey });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: undefined,
          parameters: undefined,
          response: undefined,
          userIntent: undefined,
          duration: undefined,
          isError: undefined,
          error: undefined,
        })
      );
    });

    it("should handle empty event data object", async () => {
      const customSessionId = "test-session";
      const apiKey = "phc_test";

      await publishCustomEvent(customSessionId, { apiKey });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: undefined,
          parameters: undefined,
          response: undefined,
          userIntent: undefined,
          duration: undefined,
          isError: undefined,
          error: undefined,
        })
      );
    });
  });
});
