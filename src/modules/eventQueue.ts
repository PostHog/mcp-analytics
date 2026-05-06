import KSUID from "../thirdparty/ksuid/index.js";
import type { Event, MCPServerLike, UnredactedEvent } from "../types.js";
import { getMCPCompatibleErrorMessage } from "./compatibility.js";
import { getServerTrackingData } from "./internal.js";
import { writeToLog } from "./logging.js";
import { redactEvent } from "./redaction.js";
import { sanitizeEvent } from "./sanitization.js";
import { getSessionInfo } from "./session.js";
import type { TelemetryManager } from "./telemetry.js";
import { truncateEvent } from "./truncation.js";

class EventQueue {
  private queue: UnredactedEvent[] = [];
  private processing = false;
  private maxRetries = 3;
  private maxQueueSize = 10_000; // Prevent unbounded growth
  private concurrency = 5; // Max parallel requests
  private activeRequests = 0;
  private apiBaseUrl = "https://us.i.posthog.com";
  private telemetryManager?: TelemetryManager;

  configure(apiBaseUrl: string): void {
    this.apiBaseUrl = apiBaseUrl;
  }

  setTelemetryManager(telemetryManager: TelemetryManager): void {
    this.telemetryManager = telemetryManager;
  }

  add(event: UnredactedEvent): void {
    // Drop oldest events if queue is full (or implement your preferred strategy)
    if (this.queue.length >= this.maxQueueSize) {
      writeToLog("Event queue full, dropping oldest event");
      this.queue.shift();
    }

    this.queue.push(event);
    this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && this.activeRequests < this.concurrency) {
      const event = this.queue.shift();
      if (!event) {
        continue;
      }

      if (event.redactionFn) {
        try {
          const redactedEvent = await redactEvent(event, event.redactionFn);
          event.redactionFn = undefined;
          Object.assign(event, redactedEvent);
        } catch (error) {
          writeToLog(`Failed to redact event: ${error}`);
          continue;
        }
      }

      try {
        Object.assign(event, sanitizeEvent(event));
      } catch (error) {
        writeToLog(`Failed to sanitize event: ${error}`);
        continue;
      }
      try {
        Object.assign(event, truncateEvent(event));
      } catch (error) {
        writeToLog(`Failed to truncate event: ${error}`);
        continue;
      }

      event.id = event.id || (await KSUID.withPrefix("evt").random());
      this.activeRequests++;
      this.sendEvent(event as Event).finally(() => {
        this.activeRequests--;
        this.process();
      });
    }

    this.processing = false;
  }

  private async sendEvent(event: Event, retries = 0): Promise<void> {
    // Export to telemetry if configured (fire-and-forget)
    if (this.telemetryManager) {
      this.telemetryManager.export(event).catch((error) => {
        writeToLog(
          `Telemetry export error: ${getMCPCompatibleErrorMessage(error)}`
        );
      });
    }

    // Send to PostHog capture if projectId is provided. During the SDK migration
    // this field still carries the API key inherited from the original API shape.
    if (event.projectId) {
      try {
        const url = new URL("/capture/", this.apiBaseUrl);
        const response = await fetch(url, {
          body: JSON.stringify({
            api_key: event.projectId,
            distinct_id:
              event.identifyActorGivenId || event.sessionId || "anonymous",
            event: event.eventType,
            properties: event,
            timestamp: event.timestamp.toISOString(),
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(
            `PostHog capture failed with status ${response.status}`
          );
        }
        writeToLog(
          `Successfully sent event ${event.id} | ${event.eventType} | ${event.projectId} | ${event.duration} ms | ${event.identifyActorGivenId || "anonymous"}`
        );
        writeToLog(`Event details: ${JSON.stringify(event)}`);
      } catch (error) {
        writeToLog(
          `Failed to send event ${event.id}, retrying... [Error: ${getMCPCompatibleErrorMessage(error)}]`
        );
        if (retries < this.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          await this.delay(2 ** retries * 1000);
          return this.sendEvent(event, retries + 1);
        }
        throw error;
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Get queue stats for monitoring
  getStats() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      isProcessing: this.processing,
    };
  }

  // Graceful shutdown - wait for active requests
  async destroy(): Promise<void> {
    // Stop accepting new events
    this.add = () => {
      writeToLog("Queue is shutting down, event dropped");
    };

    // Wait for queue to drain (with timeout)
    const timeout = 5000; // 5 seconds
    const start = Date.now();

    while (
      (this.queue.length > 0 || this.activeRequests > 0) &&
      Date.now() - start < timeout
    ) {
      await this.delay(100);
    }

    if (this.queue.length > 0) {
      writeToLog(
        `Shutting down with ${this.queue.length} events still in queue`
      );
    }
  }
}

export const eventQueue = new EventQueue();

// Register graceful shutdown handlers if available (Node.js only)
// Edge environments (Cloudflare Workers, etc.) don't have process signals
try {
  if (typeof process !== "undefined" && typeof process.once === "function") {
    process.once("SIGINT", () => eventQueue.destroy());
    process.once("SIGTERM", () => eventQueue.destroy());
    process.once("beforeExit", () => eventQueue.destroy());
  }
} catch {
  // process.once not available in this environment - graceful shutdown handlers not registered
}

export function setTelemetryManager(telemetryManager: TelemetryManager): void {
  eventQueue.setTelemetryManager(telemetryManager);
}

export function publishEvent(
  server: MCPServerLike,
  eventInput: UnredactedEvent
): void {
  const data = getServerTrackingData(server);
  if (!data) {
    writeToLog(
      "Warning: Server tracking data not found. Event will not be published."
    );
    return;
  }

  if (!data.options.enableTracing) {
    return;
  }

  const sessionInfo = getSessionInfo(server, data);

  // Calculate duration if not provided
  const duration =
    eventInput.duration ||
    (eventInput.timestamp
      ? new Date().getTime() - eventInput.timestamp.getTime()
      : undefined);

  // Build complete Event object with all fields explicit
  const fullEvent: UnredactedEvent = {
    // Core fields (id will be generated later in the queue)
    id: eventInput.id || "",
    sessionId: eventInput.sessionId || data.sessionId,
    projectId: data.projectId,

    // Event metadata
    eventType: eventInput.eventType || "",
    timestamp: eventInput.timestamp || new Date(),
    duration,

    // Session context from sessionInfo
    ipAddress: sessionInfo.ipAddress,
    sdkLanguage: sessionInfo.sdkLanguage,
    sdkVersion: sessionInfo.sdkVersion,
    serverName: sessionInfo.serverName,
    serverVersion: sessionInfo.serverVersion,
    clientName: sessionInfo.clientName,
    clientVersion: sessionInfo.clientVersion,

    // Actor information from sessionInfo
    identifyActorGivenId: sessionInfo.identifyActorGivenId,
    identifyActorName: sessionInfo.identifyActorName,
    identifyActorData: sessionInfo.identifyActorData,

    // Event-specific data from input
    resourceName: eventInput.resourceName,
    parameters: eventInput.parameters,
    response: eventInput.response,
    userIntent: eventInput.userIntent,
    isError: eventInput.isError,
    error: eventInput.error,

    // Preserve redaction function
    redactionFn: eventInput.redactionFn,

    // Customer-defined metadata
    tags: eventInput.tags,
    properties: eventInput.properties,
  };

  eventQueue.add(fullEvent);
}
