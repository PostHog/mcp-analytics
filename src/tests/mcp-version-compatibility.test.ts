import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it } from "vitest";
import { isCompatibleServerType } from "../modules/compatibility.js";

describe("MCP Version Compatibility", () => {
  it("should be compatible with currently installed MCP version", () => {
    // Create a new server instance
    const server = new Server(
      {
        name: "test-server",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    // Test compatibility using isCompatibleServerType
    const result = isCompatibleServerType(server);
    expect(result).toBe(server);
  });
});
