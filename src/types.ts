import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EventMessage, PostHogOptions } from "posthog-node";
import type { MCPAnalyticsEventType } from "./modules/event-types.js";

export type JsonRecord = Record<string, unknown>;

export interface MCPRequestParamsLike {
  arguments?: JsonRecord;
  name?: string;
  [key: string]: unknown;
}

export interface MCPRequestLike {
  id?: number | string;
  jsonrpc?: string;
  method?: string;
  params?: MCPRequestParamsLike;
  [key: string]: unknown;
}

export interface PostHogCaptureClient {
  capture(props: EventMessage): void;
  flush?(): Promise<void>;
  shutdown?(shutdownTimeoutMs?: number): Promise<void>;
}

export interface MCPAnalyticsOptions {
  apiKey?: string | null;
  context?: boolean | MCPAnalyticsContextOptions;
  enableAITracing?: boolean;
  enableTracing?: boolean;
  eventProperties?: (
    request: MCPRequestLike,
    extra?: CompatibleRequestHandlerExtra
  ) => JsonRecord | null | Promise<JsonRecord | null>;
  eventTags?: (
    request: MCPRequestLike,
    extra?: CompatibleRequestHandlerExtra
  ) => Record<string, string> | null | Promise<Record<string, string> | null>;
  host?: string;
  identify?: (
    request: MCPRequestLike,
    extra?: CompatibleRequestHandlerExtra
  ) => Promise<UserIdentity | null>;
  posthogClient?: PostHogCaptureClient;
  posthogOptions?: Pick<
    PostHogOptions,
    | "fetch"
    | "flushAt"
    | "flushInterval"
    | "host"
    | "requestTimeout"
    | "waitUntil"
    | "waitUntilDebounceMs"
    | "waitUntilMaxWaitMs"
  >;
  redactSensitiveInformation?: RedactFunction;
  reportMissing?: boolean;
}

export interface MCPAnalyticsContextOptions {
  description?: string;
}

export type ToolCallback =
  | ((
      args: unknown,
      extra: CompatibleRequestHandlerExtra
    ) => CallToolResult | Promise<CallToolResult>)
  | ((
      extra: CompatibleRequestHandlerExtra
    ) => CallToolResult | Promise<CallToolResult>);

// RegisteredTool type that supports both MCP SDK 1.23- (callback) and 1.24+ (handler)
export type RegisteredTool = {
  description?: string;
  inputSchema?: unknown;
  update?: (...args: unknown[]) => unknown;
} & (
  | { callback: ToolCallback; handler?: never }
  | { handler: ToolCallback; callback?: never }
);

export type RedactFunction = (text: string) => Promise<string>;

export interface Event {
  actorId?: string; // Maps to identifyActorGivenId in some contexts
  apiKey?: string; // PostHog project API key used by the default ingestion client.
  clientName?: string;
  clientVersion?: string;
  duration?: number;
  error?: ErrorData | null;
  eventId?: string; // Custom event ID

  eventType: MCPAnalyticsEventType;
  id: string;
  identifyActorData?: JsonRecord;

  // Actor/identity information
  identifyActorGivenId?: string;
  identifyActorName?: string;
  identifyData?: JsonRecord; // Legacy name for identifyActorData

  // Session context (from SessionInfo)
  ipAddress?: string;

  // Error tracking
  isError?: boolean;
  parameters?: unknown;
  properties?: JsonRecord | null;

  // Event-specific data
  resourceName?: string; // Tool/resource name
  response?: unknown;
  sdkLanguage?: string;
  sdkVersion?: string;
  serverName?: string;
  serverVersion?: string;
  sessionId: string;

  // Customer-defined metadata
  tags?: Record<string, string> | null;
  timestamp: Date;
  userIntent?: string;
}

export interface UnredactedEvent extends Partial<Event> {
  redactionFn?: RedactFunction; // Optional redaction function for sensitive data
}

// Use our own minimal interface for what we actually need
export interface CompatibleRequestHandlerExtra {
  headers?: Record<string, string | string[]>;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ServerClientInfoLike {
  name?: string;
  version?: string;
}

export interface HighLevelMCPServerLike {
  _registeredTools: { [name: string]: RegisteredTool };
  registerTool?(
    name: string,
    config: {
      description?: string;
      inputSchema?: unknown;
    },
    handler: ToolCallback
  ): void;
  server: MCPServerLike;
  // Tool registration methods - simplified signatures without Zod dependency
  tool?(name: string, cb: ToolCallback): void;
  tool?(name: string, paramsSchema: unknown, cb: ToolCallback): void;
  tool?(
    name: string,
    description: string,
    paramsSchema: unknown,
    cb: ToolCallback
  ): void;
}

export interface MCPServerLike {
  _requestHandlers: Map<
    string,
    (
      request: MCPRequestLike,
      extra?: CompatibleRequestHandlerExtra
    ) => Promise<unknown>
  >;
  _serverInfo?: ServerClientInfoLike;
  getClientVersion(): ServerClientInfoLike | undefined;
  setRequestHandler(
    schema: unknown,
    handler: (
      request: MCPRequestLike,
      extra?: CompatibleRequestHandlerExtra
    ) => Promise<unknown>
  ): void;
}

export interface UserIdentity {
  userData?: JsonRecord; // Additional user data
  userId: string; // Unique identifier for the user
  userName?: string; // Optional user name
}

export interface SessionInfo {
  clientName?: string;
  clientVersion?: string;
  identifyActorData?: JsonRecord;
  identifyActorGivenId?: string; // Actor ID for posthog:identify events
  identifyActorName?: string; // Actor name for posthog:identify events
  ipAddress?: string;
  sdkLanguage?: string;
  sdkVersion?: string;
  serverName?: string;
  serverVersion?: string;
}

export interface MCPAnalyticsData {
  apiKey: string;
  identifiedSessions: Map<string, UserIdentity>;
  lastActivity: Date; // Last activity timestamp
  lastMcpSessionId?: string; // Track the last MCP sessionId we saw
  options: MCPAnalyticsOptions;
  sessionId: string; // Unique SDK session identifier.
  sessionInfo: SessionInfo;
  sessionSource: "generated" | "mcp"; // Track whether session ID came from MCP protocol or SDK generation
}

// Error tracking types
export interface StackFrame {
  abs_path?: string;
  colno?: number;
  context_line?: string; // The line of code where the error occurred
  filename: string;
  function: string; // Function name or "<anonymous>"
  in_app: boolean;
  lineno?: number;
}

export interface ChainedErrorData {
  frames?: StackFrame[];
  message: string;
  stack?: string;
  type?: string;
}

export interface ErrorData {
  chained_errors?: ChainedErrorData[];
  frames?: StackFrame[]; // Parsed stack frames
  message: string;
  platform?: string; // Platform identifier (e.g., "javascript", "node")
  stack?: string; // Full stack trace string
  type?: string; // Error class name (e.g., "TypeError", "Error")
  [key: string]: unknown;
}

// Custom event types for publishCustomEvent function
export interface CustomEventData {
  apiKey?: string | null;
  duration?: number;
  error?: unknown;
  isError?: boolean;
  message?: string;
  parameters?: unknown;
  posthogClient?: PostHogCaptureClient;
  properties?: JsonRecord;
  resourceName?: string;
  response?: unknown;
  tags?: Record<string, string>;
}
