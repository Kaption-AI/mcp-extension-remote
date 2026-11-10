/**
 * Parity test: verifies that the cloud bridge tool definitions are identical
 * to the local bridge (kaption-mcp) tool definitions.
 *
 * This prevents the two from drifting apart again.
 * The local bridge (kaption-mcp/src/tools.ts) is the canonical source of truth.
 *
 * Skips in CI where the local bridge repo isn't available as a sibling directory.
 */

import { describe, it, expect } from "vitest";
import { TOOLS as CLOUD_TOOLS, zodToJsonSchema, type ToolDefinition } from "./tools";
import { existsSync } from "fs";
import { resolve } from "path";

const localToolsPath = process.env.MCP_LOCAL_TOOLS_PATH || resolve(__dirname, "../../kaption-mcp/src/tools.ts");
const hasLocalBridge = existsSync(localToolsPath);

let LOCAL_TOOLS: ToolDefinition[] = [];

if (hasLocalBridge) {
  // Dynamic import only when the file exists (local dev, not CI)
  const mod = await import(/* @vite-ignore */ localToolsPath);
  LOCAL_TOOLS = mod.TOOLS;
}

describe.skipIf(!hasLocalBridge)("Tool parity: local ↔ cloud", () => {
  it("same number of tools", () => {
    expect(CLOUD_TOOLS).toHaveLength(LOCAL_TOOLS.length);
  });

  it("same tool names in same order", () => {
    const cloudNames = CLOUD_TOOLS.map((t) => t.name);
    const localNames = LOCAL_TOOLS.map((t) => t.name);
    expect(cloudNames).toEqual(localNames);
  });

  it("same annotations and _meta for the manage tools (mcp-manage-kaption.LIST.2, UI.1)", () => {
    for (const name of [
      "get_kaption_settings", "update_kaption_settings", "reconnect_kaption_connection", "kaption_help", "report_bug", "get_business_agent", "manage_business_agent", "kaption_plans", "create_kaption_checkout_link", "manage_status", "list_status_posts",
      "manage_channels", "manage_communities", "list_channels", "get_channel", "list_communities", "get_community",
    ]) {
      const cloud = CLOUD_TOOLS.find((t) => t.name === name)!;
      const local = LOCAL_TOOLS.find((t) => t.name === name)!;
      expect(cloud.annotations, name).toEqual(local.annotations);
      expect(cloud._meta, name).toEqual(local._meta);
    }
  });

  it("the same plans page as the local hub (mcp-manage-kaption.UI.1)", async () => {
    const localUi = resolve(localToolsPath, "../plansUi.ts");
    if (!existsSync(localUi)) return;
    const local = await import(/* @vite-ignore */ localUi);
    const cloud = await import("./plans-ui");
    expect(cloud.PLANS_UI_HTML).toBe(local.PLANS_UI_HTML);
    expect(cloud.PLANS_UI_MIME_TYPE).toBe(local.PLANS_UI_MIME_TYPE);
  });

  it("same descriptions for every tool", () => {
    for (let i = 0; i < LOCAL_TOOLS.length; i++) {
      expect(CLOUD_TOOLS[i].description, `description mismatch for ${LOCAL_TOOLS[i].name}`).toBe(
        LOCAL_TOOLS[i].description
      );
    }
  });

  it("cloud JSON Schema has descriptions on all fields", () => {
    for (const tool of CLOUD_TOOLS) {
      const jsonSchema = zodToJsonSchema(tool.inputSchema);
      const props = jsonSchema.properties as Record<string, any> | undefined;
      if (!props) continue;
      for (const [key, prop] of Object.entries(props)) {
        expect(
          prop.description ?? prop.oneOf,
          `${tool.name}.${key} missing description`
        ).toBeDefined();
      }
    }
  });

  it("both parse the same sample inputs identically", () => {
    const sampleInputs: Record<string, Record<string, unknown>> = {
      query: { entity: "session" },
      summarize_conversation: { conversation_id: "abc@c.us" },
      manage_labels: { action: "add", label_name: "test", conversation_id: "abc@c.us" },
      manage_notes: { action: "set", contact_id: "abc@c.us", note: "VIP" },
      download_media: { message_id: "msg-1", conversation_id: "abc@c.us" },
      manage_chat: { action: "archive", conversation_id: "abc@c.us" },
      manage_reminders: { action: "complete", id: "rem_1" },
      manage_scheduled_messages: { action: "create", mode: "local", message: "hi", datetime: "2026-10-01T09:00:00Z", conversation_id: "120363000000000000@g.us" },
      manage_lists: { action: "add_chat", name: "Family", conversation_id: "abc@c.us" },
      list_reminders: { filter: "all" },
      get_reminder: { id: "rem_1" },
      list_scheduled_messages: { mode: "local" },
      get_scheduled_message: { id: "m1", mode: "local" },
      list_chat_lists: {},
      get_chat_list: { name: "Family" },
      get_contact_note: { contact_id: "abc@c.us" },
      get_api_info: {},
      call_recordings: { action: "search", search: "budget", limit: 5 },
      get_kaption_settings: {},
      update_kaption_settings: { id: "transcription.automatic", value: false },
      reconnect_kaption_connection: { bridge: "local" },
      kaption_help: { action: "read", topic: "pricing" },
      report_bug: { description: "The pill does not open", expected: "It opens" },
      get_business_agent: { action: "eval_results", job_id: "j1", eval_case_ids: ["a"] },
      manage_business_agent: { action: "run_evals", eval_case_ids: ["a", "b"], confirmation_token: "t" },
      kaption_plans: {},
      create_kaption_checkout_link: { plan: "pro", period: "monthly", method: "card" },
      manage_status: { action: "schedule", datetime: "2026-12-01T09:00:00Z", text: "Open today", background_color: "#25D366", font: 2 },
      list_status_posts: { filter: "all" },
      manage_channels: { action: "cross_post", text: "Closed on Friday", targets: ["1@newsletter", { id: "2@g.us", text: "Closed Friday" }] },
      manage_communities: { action: "create", name: "Neighbours", group_ids: ["3@g.us"] },
      list_channels: {},
      get_channel: { id: "1@newsletter" },
      list_communities: {},
      get_community: { id: "2@g.us" },
    };
    // scheduled-status.MCP.9 — a status photo by upload ref (preferred) and the inline form, parsed the same.
    const statusSamples = [
      { action: "schedule", datetime: "2026-12-01T09:00:00Z", attachment: { ref: "a".repeat(64) }, caption: "Menu" },
      { action: "schedule", datetime: "2026-12-01T09:00:00Z", attachment: { name: "menu.png", mime: "image/png", dataB64: "YWJj" } },
    ];
    for (const input of statusSamples) {
      const cloud = CLOUD_TOOLS.find((t) => t.name === "manage_status")!.inputSchema.safeParse(input);
      const local = LOCAL_TOOLS.find((t) => t.name === "manage_status")!.inputSchema.safeParse(input);
      expect(cloud.success && local.success).toBe(true);
      if (cloud.success && local.success) expect(cloud.data).toEqual(local.data);
    }

    for (const [name, input] of Object.entries(sampleInputs)) {
      const cloudTool = CLOUD_TOOLS.find((t) => t.name === name)!;
      const localTool = LOCAL_TOOLS.find((t) => t.name === name)!;

      const cloudResult = cloudTool.inputSchema.safeParse(input);
      const localResult = localTool.inputSchema.safeParse(input);

      expect(cloudResult.success, `cloud parse failed for ${name}`).toBe(true);
      expect(localResult.success, `local parse failed for ${name}`).toBe(true);

      if (cloudResult.success && localResult.success) {
        expect(cloudResult.data, `parse output mismatch for ${name}`).toEqual(localResult.data);
      }
    }
  });

  it("both reject the same invalid inputs", () => {
    const invalidInputs: Record<string, Record<string, unknown>> = {
      query: { entity: "invalid" },
      summarize_conversation: {},
      manage_labels: { action: "invalid" },
      manage_notes: { action: "get" },
      download_media: { message_id: "msg-1" },
      manage_chat: { action: "archive" },
      manage_reminders: { action: "list" },
      manage_scheduled_messages: { action: "get", id: "m1" },
      manage_lists: { action: "list" },
      get_reminder: {},
      update_kaption_settings: {},
      get_business_agent: { action: "pause" },
      manage_business_agent: { action: "status" },
      create_kaption_checkout_link: { plan: "free" },
      manage_status: { action: "post_now", text: "Hi" },
      list_status_posts: { filter: "later" },
      manage_channels: { action: "schedule", id: "1@newsletter", posts: Array(15).fill({ text: "x", datetime: "2026-12-01T09:00:00Z" }) },
      manage_communities: { action: "delete", id: "2@g.us" },
      get_channel: {},
      get_community: {},
    };

    // scheduled-status.MCP.9 — a GIF, a malformed ref, a ref with extra fields and a path are refused by both.
    for (const attachment of [{ name: "a.gif", mime: "image/gif", dataB64: "YWJj" }, { ref: "short" }, { ref: "a".repeat(64), name: "a.png" }, { path: "/tmp/a.png" }]) {
      const input = { action: "schedule", datetime: "2026-12-01T09:00:00Z", attachment };
      expect(CLOUD_TOOLS.find((t) => t.name === "manage_status")!.inputSchema.safeParse(input).success).toBe(false);
      expect(LOCAL_TOOLS.find((t) => t.name === "manage_status")!.inputSchema.safeParse(input).success).toBe(false);
    }

    for (const [name, input] of Object.entries(invalidInputs)) {
      const cloudTool = CLOUD_TOOLS.find((t) => t.name === name)!;
      const localTool = LOCAL_TOOLS.find((t) => t.name === name)!;

      const cloudResult = cloudTool.inputSchema.safeParse(input);
      const localResult = localTool.inputSchema.safeParse(input);

      expect(cloudResult.success, `cloud should reject invalid ${name}`).toBe(false);
      expect(localResult.success, `local should reject invalid ${name}`).toBe(false);
    }
  });
});
