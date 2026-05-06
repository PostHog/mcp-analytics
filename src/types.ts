import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EventMessage, PostHogOptions } from "posthog-node";

export interface PostHogCaptureClient {
  capture(props: EventMessage): void;
  flush?(): Promise<void>;
  shutdown?(shutdownTimeoutMs?: number): Promise<void>;
}

export interface MCPAnalyticsOptions {
  apiKey?: string | null;
  context?: boolean | MCPAnalyticsContextOptions;
  enableTracing?: boolean;
  eventProperties?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra
  ) => Record<string, any> | null | Promise<Record<string, any> | null>;
  eventTags?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra
  ) => Record<string, string> | null | Promise<Record<string, string> | null>;
  exporters?: Record<string, ExporterConfig>;
  host?: string;
  identify?: (
    request: any,
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
      args: any,
      extra: CompatibleRequestHandlerExtra
    ) => CallToolResult | Promise<CallToolResult>)
  | ((
      extra: CompatibleRequestHandlerExtra
    ) => CallToolResult | Promise<CallToolResult>);

// RegisteredTool type that supports both MCP SDK 1.23- (callback) and 1.24+ (handler)
export type RegisteredTool = {
  description?: string;
  inputSchema?: any;
  update?: (...args: any[]) => any;
} & (
  | { callback: ToolCallback; handler?: never }
  | { handler: ToolCallback; callback?: never }
);

export type RedactFunction = (text: string) => Promise<string>;

export interface ExporterConfig {
  type: string;
  [key: string]: any;
}

export interface Exporter {
  export(event: Event): Promise<void>;
}

export const MCPAnalyticsIDPrefixes = {
  Event: "evt",
  Session: "ses",
} as const;

export type MCPAnalyticsIDPrefix =
  (typeof MCPAnalyticsIDPrefixes)[keyof typeof MCPAnalyticsIDPrefixes];

export interface Event {
  actorId?: string; // Maps to identifyActorGivenId in some contexts
  apiKey?: string; // PostHog project API key used by the default ingestion client.
  clientName?: string;
  clientVersion?: string;
  duration?: number;
  error?: ErrorData;
  eventId?: string; // Custom event ID

  // Event metadata
  eventType: string; // Changed from enum to string for flexibility
  // Core identification
  id: string;
  identifyActorData?: object;

  // Actor/identity information
  identifyActorGivenId?: string;
  identifyActorName?: string;
  identifyData?: object; // Legacy name for identifyActorData

  // Session context (from SessionInfo)
  ipAddress?: string;

  // Error tracking
  isError?: boolean;
  parameters?: any;
  properties?: Record<string, any> | null;

  // Event-specific data
  resourceName?: string; // Tool/resource name
  response?: any;
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
  [key: string]: any;
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
      inputSchema?: any;
    },
    handler: ToolCallback
  ): void;
  server: MCPServerLike;
  // Tool registration methods - simplified signatures without Zod dependency
  tool?(name: string, cb: ToolCallback): void;
  tool?(name: string, paramsSchema: any | string, cb: ToolCallback): void;
  tool?(
    name: string,
    description: string,
    paramsSchema: any,
    cb: ToolCallback
  ): void;
}

export interface MCPServerLike {
  _requestHandlers: Map<
    string,
    (request: any, extra?: CompatibleRequestHandlerExtra) => Promise<any>
  >;
  _serverInfo?: ServerClientInfoLike;
  getClientVersion(): ServerClientInfoLike | undefined;
  setRequestHandler(
    schema: any,
    handler: (
      request: any,
      extra?: CompatibleRequestHandlerExtra
    ) => Promise<any>
  ): void;
}

export interface UserIdentity {
  userData?: Record<string, any>; // Additional user data
  userId: string; // Unique identifier for the user
  userName?: string; // Optional user name
}

export interface SessionInfo {
  clientName?: string;
  clientVersion?: string;
  identifyActorData?: object;
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
  sessionId: string; // Unique identifier for the session (KSUID with ses prefix)
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
}

// Custom event types for publishCustomEvent function
export interface CustomEventData {
  apiKey?: string | null;
  duration?: number;
  error?: any;
  isError?: boolean;
  message?: string;
  parameters?: any;
  posthogClient?: PostHogCaptureClient;
  properties?: Record<string, any>;
  resourceName?: string;
  response?: any;
  tags?: Record<string, string>;
}
