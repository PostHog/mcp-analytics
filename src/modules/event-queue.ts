import { PostHog } from "posthog-node";
import type {
  Event,
  MCPAnalyticsOptions,
  MCPServerLike,
  PostHogCaptureClient,
  UnredactedEvent,
} from "../types.js";
import { getMCPCompatibleErrorMessage } from "./compatibility.js";
import { MCPAnalyticsEventType } from "./event-types.js";
import { newPrefixedId } from "./ids.js";
import { getServerTrackingData } from "./internal.js";
import { writeToLog } from "./logging.js";
import { buildPostHogCaptureEvents } from "./posthog-events.js";
import { redactEvent } from "./redaction.js";
import { sanitizeEvent } from "./sanitization.js";
import { getSessionInfo } from "./session.js";
import { truncateEvent } from "./truncation.js";

interface QueuedEvent {
  enableAITracing?: boolean;
  event: UnredactedEvent;
  posthogClient?: PostHogCaptureClient;
}

class EventQueue {
  private readonly queue: QueuedEvent[] = [];
  private processing = false;
  private readonly maxQueueSize = 10_000; // Prevent unbounded growth
  private readonly concurrency = 5; // Max parallel requests
  private activeRequests = 0;
  private host = "https://us.i.posthog.com";
  private posthogOptions: NonNullable<MCPAnalyticsOptions["posthogOptions"]> =
    {};
  private readonly posthogClients = new Map<string, PostHogCaptureClient>();

  configure(host: string): void {
    this.host = host;
    this.posthogClients.clear();
  }

  configurePostHogOptions(
    posthogOptions: NonNullable<MCPAnalyticsOptions["posthogOptions"]>
  ): void {
    this.posthogOptions = {
      ...this.posthogOptions,
      ...posthogOptions,
    };
    if (posthogOptions.host) {
      this.host = posthogOptions.host;
    }
    this.posthogClients.clear();
  }

  add(
    event: UnredactedEvent,
    posthogClient?: PostHogCaptureClient,
    enableAITracing = false
  ): void {
    // Drop oldest events if queue is full (or implement your preferred strategy)
    if (this.queue.length >= this.maxQueueSize) {
      writeToLog("Event queue full, dropping oldest event");
      this.queue.shift();
    }

    this.queue.push({ enableAITracing, event, posthogClient });
    this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && this.activeRequests < this.concurrency) {
      const queuedEvent = this.queue.shift();
      if (!queuedEvent) {
        continue;
      }
      const { enableAITracing, event, posthogClient } = queuedEvent;

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

      event.id = event.id || newPrefixedId("evt");
      this.activeRequests++;
      try {
        this.sendEvent(event as Event, posthogClient, enableAITracing);
      } finally {
        this.activeRequests--;
        this.process();
      }
    }

    this.processing = false;
  }

  private sendEvent(
    event: Event,
    posthogClientOverride?: PostHogCaptureClient,
    enableAITracing = false
  ): void {
    const posthogClient = this.getPostHogClient(
      event.apiKey,
      posthogClientOverride
    );
    if (posthogClient) {
      try {
        for (const captureEvent of buildPostHogCaptureEvents(event, {
          enableAITracing,
        })) {
          posthogClient.capture({
            distinctId: captureEvent.distinct_id,
            event: captureEvent.event,
            properties: captureEvent.properties,
            timestamp: new Date(captureEvent.timestamp),
          });
        }
        writeToLog(
          `Queued PostHog event ${event.id} | ${event.eventType} | ${event.duration} ms | ${event.identifyActorGivenId || "anonymous"}`
        );
      } catch (error) {
        writeToLog(
          `Failed to queue PostHog event ${event.id}: ${getMCPCompatibleErrorMessage(error)}`
        );
        throw error;
      }
    }
  }

  private getPostHogClient(
    apiKey?: string,
    posthogClient?: PostHogCaptureClient
  ): PostHogCaptureClient | undefined {
    if (posthogClient) {
      return posthogClient;
    }

    if (!apiKey) {
      return;
    }

    const existingClient = this.posthogClients.get(apiKey);
    if (existingClient) {
      return existingClient;
    }

    const client = new PostHog(apiKey, {
      ...this.posthogOptions,
      host: this.host,
    });
    this.posthogClients.set(apiKey, client);
    return client;
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

    const shutdowns: Promise<void>[] = [];
    for (const client of this.posthogClients.values()) {
      if (client.shutdown) {
        shutdowns.push(client.shutdown(timeout));
      } else if (client.flush) {
        shutdowns.push(client.flush());
      }
    }
    await Promise.allSettled(shutdowns);
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
      ? Date.now() - eventInput.timestamp.getTime()
      : undefined);

  // Build complete Event object with all fields explicit
  const fullEvent: UnredactedEvent = {
    // Core fields (id will be generated later in the queue)
    id: eventInput.id || "",
    sessionId: eventInput.sessionId || data.sessionId,
    apiKey: data.apiKey,

    // Event metadata
    eventType: eventInput.eventType || MCPAnalyticsEventType.custom,
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

  if (data.options.posthogClient) {
    eventQueue.add(
      fullEvent,
      data.options.posthogClient,
      data.options.enableAITracing
    );
  } else {
    eventQueue.add(fullEvent, undefined, data.options.enableAITracing);
  }
}
