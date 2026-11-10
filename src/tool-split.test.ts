import { describe, expect, it } from "vitest";
import { CLOUD_TOOLS, TOOL_ROUTES, TOOLS, getToolsForMCP, routeToolCall } from "./tools";
import { NO_ACCOUNT_TEXT, toolErrorText } from "./tool-errors";

// mcp.TOOLS.19 — Claude's Connectors Directory rejects a tool that takes both safe and unsafe operations, so every
// read has its own read-only tool and the manage_* tools only write.
// mcp-manage-kaption.LIST.5 — and the read actions of kaption_help and get_business_agent.
const READ_ACTIONS = new Set([
  "list",
  "get",
  "search",
  "read",
  "prompts",
  "status",
  "get_instructions",
  "list_knowledge",
  "list_tools",
  "activity",
  "list_evals",
  "eval_results",
]);

function actionsOf(name: string): string[] {
  const tool = getToolsForMCP().find((t) => t.name === name)!;
  const action = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).action;
  return action?.enum ?? [];
}

describe("read and write tools are separate (mcp.TOOLS.19)", () => {
  it("no write tool accepts a read action, and no read-only tool a write action", () => {
    for (const tool of getToolsForMCP()) {
      const actions = actionsOf(tool.name);
      if (actions.length === 0) continue;
      if (tool.annotations?.readOnlyHint) {
        expect(actions.every((a) => READ_ACTIONS.has(a)), tool.name).toBe(true);
      } else {
        expect(actions.filter((a) => READ_ACTIONS.has(a)), tool.name).toEqual([]);
      }
    }
  });

  it("every routed read tool is public, read-only and not destructive", () => {
    for (const name of Object.keys(TOOL_ROUTES)) {
      const tool = CLOUD_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool!.inputSchema.safeParse({}).success || name.startsWith("get_"), name).toBe(true);
    }
  });

  it("routes each read tool to the manage_* method and action older Kaption versions answer", () => {
    expect(routeToolCall("list_reminders", { filter: "all" })).toEqual({
      method: "manage_reminders",
      params: { filter: "all", action: "list" },
    });
    expect(routeToolCall("get_reminder", { id: "r1" })).toEqual({ method: "manage_reminders", params: { id: "r1", action: "get" } });
    expect(routeToolCall("list_scheduled_messages", { mode: "local" })).toEqual({
      method: "manage_scheduled_messages",
      params: { mode: "local", action: "list" },
    });
    expect(routeToolCall("get_scheduled_message", { id: "m1", mode: "local" }).params).toEqual({ id: "m1", mode: "local", action: "get" });
    expect(routeToolCall("list_chat_lists", {})).toEqual({ method: "manage_lists", params: { action: "list" } });
    expect(routeToolCall("get_chat_list", { name: "Family" })).toEqual({ method: "manage_lists", params: { name: "Family", action: "get" } });
    expect(routeToolCall("get_contact_note", { contact_id: "a@c.us" })).toEqual({
      method: "manage_notes",
      params: { contact_id: "a@c.us", action: "get" },
    });
  });

  it("a caller cannot turn a read tool into a write by passing action", () => {
    const tool = TOOLS.find((t) => t.name === "list_reminders")!;
    const parsed = tool.inputSchema.safeParse({ action: "delete" });
    const args = parsed.success ? (parsed.data as Record<string, unknown>) : {};
    expect(args.action).toBeUndefined();
    expect(routeToolCall("list_reminders", { action: "delete" } as Record<string, unknown>).params.action).toBe("list");
  });

  it("routes the channel and community read tools to the manage_* read actions (whatsapp-channels-communities.MCP_ROUTES.4)", () => {
    expect(routeToolCall("list_channels", { action: "create" } as Record<string, unknown>)).toEqual({ method: "manage_channels", params: { action: "list" } });
    expect(routeToolCall("get_community", { id: "2@g.us" })).toEqual({ method: "manage_communities", params: { id: "2@g.us", action: "get" } });
    expect(routeToolCall("list_scheduled_channel_posts", { filter: "all" })).toEqual({ method: "manage_channels", params: { filter: "all", action: "scheduled" } });
    expect(routeToolCall("get_community_digest", { id: "2@g.us", since: "2026-11-08T00:00:00Z" })).toEqual({
      method: "manage_communities",
      params: { id: "2@g.us", since: "2026-11-08T00:00:00Z", action: "digest" },
    });
  });

  it("passes every other tool through unchanged", () => {
    expect(routeToolCall("manage_reminders", { action: "create", title: "x" })).toEqual({
      method: "manage_reminders",
      params: { action: "create", title: "x" },
    });
  });

  it("describes tools without telling the assistant what to call first", () => {
    const text = JSON.stringify(getToolsForMCP().map((t) => t.description));
    expect(text).not.toMatch(/\bFIRST\b|\bDo NOT\b|\bIMPORTANT\b|check with action/);
  });
});

describe("tool errors say what to do (mcp.CLOUD_RELAY.21)", () => {
  it("explains an offline extension", () => {
    const text = toolErrorText("query", Object.assign(new Error("Extension not connected. Open WhatsApp Web with Kaption extension and enable cloud bridge."), { code: "offline" }));
    expect(text).toMatch(/^Error: Extension not connected: /);
    expect(text).toMatch(/Open WhatsApp Web with the Kaption extension/);
  });

  it("explains a timeout with its length", () => {
    expect(toolErrorText("query", new Error("Request timed out after 30s"))).toMatch(/within 30 seconds.*limit/);
  });

  it("explains a Kaption version without the tool", () => {
    const text = toolErrorText("send_message", Object.assign(new Error("Method not found: send_message"), { code: -32601 }));
    expect(text).toMatch(/cannot run send_message yet\. Update the Kaption extension or desktop app/);
  });

  it("never answers with a bare generic error", () => {
    expect(toolErrorText("query", new Error("Extension returned error"))).toMatch(/could not complete query/);
    expect(toolErrorText("query", null)).toMatch(/could not complete query/);
  });

  it("keeps the extension's own actionable messages", () => {
    const refusal = "Sending WhatsApp messages from an assistant isn't turned on for this account, so nothing was sent. (reason: flag-off)";
    expect(toolErrorText("send_message", Object.assign(new Error(refusal), { code: -32602 }))).toBe(`Error: ${refusal}`);
  });

  it("tells a connection without an account how to reconnect", () => {
    expect(NO_ACCOUNT_TEXT).toMatch(/connect it again/);
  });
});
