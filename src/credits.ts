/**
 * What one recorded Claude/ChatGPT call spends, in credits (kaptionai features/mcp/mcp-usage-ledger.feature.yaml
 * CREDITS.3, mcp-usage-pricing.CREDIT.1). The same table and classes as the extension's mcpCallClass
 * (kext/src/core/mcp/mcpUsagePricing.ts); credits.test.ts replays the extension's fixture (its `class` cases).
 *
 * The ledger knows a call by its tool name (the published name, a routed read such as list_reminders included) and its
 * fixed-enum kind (usage.ts usageKind / knownKind). A read that made the backend transcribe a voice note is 2 credits
 * on the device; the relay cannot see that and counts it as a plain read (1).
 */
import { TOOL_ROUTES } from "./tools";
import { UNCOUNTED_TOOLS } from "./weekly-usage";

export type CreditClass = "free" | "read" | "change" | "send" | "summary" | "export";

/** mcp-usage-pricing.CREDIT.1 — the credits of each class (read_transcribed 2 is the device's only). */
export const CREDIT_COST: Readonly<Record<CreditClass, number>> = { free: 0, read: 1, change: 1, send: 2, summary: 3, export: 5 };

const READ_ACTIONS = new Set(["list", "get", "search", "read", "scheduled", "digest"]);
const SEND_ACTIONS: Record<string, ReadonlySet<string>> = {
  manage_scheduled_messages: new Set(["create", "update", "send_now"]),
  manage_reminders: new Set(["create", "update"]),
  manage_status: new Set(["schedule"]),
  manage_channels: new Set(["post", "schedule", "cross_post"]),
  manage_communities: new Set(["announce", "schedule_announcement"]),
};

/** mcp-usage-ledger.CREDITS.3 — the class of one call by its tool and kind ("" when the kind is unknown). */
export function creditClass(tool: string, kind: string): CreditClass {
  const route = TOOL_ROUTES[tool];
  const method = route ? route.method : tool;
  const action = (route ? route.action : kind || "").toLowerCase();
  if (UNCOUNTED_TOOLS.has(tool) || UNCOUNTED_TOOLS.has(method)) return "free";
  if (method === "summarize_conversation") return "summary";
  if (method === "export_contacts" || method === "export_chat") return "export";
  if (method === "get_analytics") return action === "export_contacts" ? "export" : "read";
  if (method === "call_recordings") return action === "list" || action === "search" ? "read" : "export";
  if (method === "send_message" || method === "create_attachment_upload") return "send";
  // kaption-links.MCP.5 — create_tracked_links is a send (2 credits); list_tracked_links and get_link_clicks fall
  // through to read (1).
  if (method === "create_tracked_links") return "send";
  if (method.startsWith("manage_")) {
    if (READ_ACTIONS.has(action)) return "read";
    if (SEND_ACTIONS[method]?.has(action)) return "send";
    return "change";
  }
  return "read";
}

/** mcp-usage-ledger.CREDITS.3 — the credits of one call. */
export const creditsOf = (tool: string, kind: string): number => CREDIT_COST[creditClass(tool, kind)];

/** mcp-usage-ledger.CREDITS.6 — a reservation's credits as a caller sent them: a whole number 0-100, else 1. */
export function reservationCredits(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100 ? (value as number) : 1;
}
