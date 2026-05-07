import { createHash, randomUUID } from "node:crypto";

export type MCPAnalyticsIDPrefix = "evt" | "ses";

export function newPrefixedId(prefix: MCPAnalyticsIDPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

export function deterministicPrefixedId(
  prefix: MCPAnalyticsIDPrefix,
  input: string
): string {
  const hash = createHash("sha256").update(input).digest("hex");
  return `${prefix}_${hash.slice(0, 32)}`;
}
