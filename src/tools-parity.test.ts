/**
 * Parity test: verifies that the cloud bridge tool definitions are identical
 * to the local bridge (kaption-mcp) tool definitions.
 *
 * This prevents the two from drifting apart again.
 * The local bridge (kaption-mcp/src/tools.ts) is the canonical source of truth.
 *
 * NOTE: We cannot use zodToJsonSchema across module boundaries because
 * instanceof checks fail when zod is loaded from different node_modules.
 * Instead we compare descriptions, tool names, and parse behavior directly.
 */

import { describe, it, expect } from "vitest";
import { TOOLS as CLOUD_TOOLS, zodToJsonSchema } from "./tools";
import { TOOLS as LOCAL_TOOLS } from "../../kaption-mcp/src/tools";

describe("Tool parity: local ↔ cloud", () => {
  it("same number of tools", () => {
    expect(CLOUD_TOOLS).toHaveLength(LOCAL_TOOLS.length);
  });

  it("same tool names in same order", () => {
    const cloudNames = CLOUD_TOOLS.map((t) => t.name);
    const localNames = LOCAL_TOOLS.map((t) => t.name);
    expect(cloudNames).toEqual(localNames);
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
        // Union types (oneOf) don't have a top-level description, that's ok
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
      manage_notes: { action: "get", contact_id: "abc@c.us" },
      download_media: { message_id: "msg-1", conversation_id: "abc@c.us" },
      manage_chat: { action: "archive", conversation_id: "abc@c.us" },
      manage_reminders: { action: "list" },
      manage_scheduled_messages: { action: "list" },
      manage_lists: { action: "list" },
      get_api_info: {},
    };

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
      manage_notes: { action: "get" }, // missing contact_id
      download_media: { message_id: "msg-1" }, // missing conversation_id
      manage_chat: { action: "archive" }, // missing conversation_id
    };

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
