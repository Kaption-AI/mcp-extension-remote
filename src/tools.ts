/**
 * Tool definitions for the remote MCP relay.
 * These mirror the tools from @kaptionai/mcp-extension.
 * The relay doesn't execute them — it forwards JSON-RPC to the extension.
 */

import { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "query",
    description: [
      "Query WhatsApp data: conversations, contacts, messages, transcriptions, labels, and communities.",
      "Supports listing, searching, filtering, and looking up by ID.",
      "",
      "IMPORTANT: Multiple WhatsApp accounts may be connected (e.g. personal + business).",
      "Always query entity=\"session\" FIRST to see all connected accounts and their session IDs.",
      "Then use target_session to route queries to the correct account.",
      "",
      "Examples:",
      '  List sessions: { entity: "session" }',
      "  List conversations: {}",
      '  Search everything: { query: "meeting" }',
      "  Unread conversations: { unread: true }",
      '  Lookup conversation: { id: "5491157390064@c.us" }',
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().optional(),
      id: z.string().optional(),
      entity: z
        .enum(["conversations", "contacts", "messages", "transcriptions", "labels", "communities", "session"])
        .optional(),
      limit: z.number().min(1).max(5000).optional().default(25),
      unread: z.boolean().optional(),
      label: z.string().optional(),
      list: z.string().optional(),
      community: z.string().optional(),
      group: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      include_participants: z.boolean().optional(),
      target_session: z.string().optional(),
    }),
  },
  {
    name: "summarize_conversation",
    description: "Get or generate a summary of a conversation",
    inputSchema: z.object({
      conversation_id: z.string(),
      message_count: z.number().min(1).max(500).optional(),
      target_session: z.string().optional(),
    }),
  },
  {
    name: "manage_labels",
    description: [
      "Manage WhatsApp Business labels.",
      "Actions: add, remove, create, delete",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["add", "remove", "create", "delete"]),
      label_name: z.string().optional(),
      label_id: z.string().optional(),
      conversation_id: z.union([z.string(), z.array(z.string())]).optional(),
    }),
  },
  {
    name: "manage_notes",
    description: "Manage contact notes (get/set). Requires WhatsApp Business.",
    inputSchema: z.object({
      action: z.enum(["get", "set"]),
      contact_id: z.string(),
      note: z.string().optional(),
    }),
  },
  {
    name: "download_media",
    description: "Download media content from a WhatsApp message. Returns base64-encoded data.",
    inputSchema: z.object({
      message_id: z.string(),
      conversation_id: z.string(),
      target_session: z.string().optional(),
    }),
  },
  {
    name: "manage_chat",
    description: [
      "Manage chat state: archive, unarchive, mark_read, mark_unread, pin, unpin, mute, unmute, set_draft, clear_draft.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["archive", "unarchive", "mark_read", "mark_unread", "pin", "unpin", "mute", "unmute", "set_draft", "clear_draft"]),
      conversation_id: z.string(),
      mute_duration: z.enum(["8h", "1w", "forever"]).optional(),
      text: z.string().optional(),
      target_session: z.string().optional(),
    }),
  },
  {
    name: "manage_reminders",
    description: "Manage personal reminders: list, get, create, update, delete, complete, uncomplete.",
    inputSchema: z.object({
      action: z.enum(["list", "get", "create", "update", "delete", "complete", "uncomplete"]),
      filter: z.enum(["active", "completed", "all"]).optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      datetime: z.string().optional(),
      notification_type: z.enum(["extension", "whatsapp", "automatic"]).optional(),
      target_session: z.string().optional(),
    }),
  },
  {
    name: "manage_scheduled_messages",
    description: "Schedule messages: list, get, create, update, delete.",
    inputSchema: z.object({
      action: z.enum(["list", "get", "create", "update", "delete"]),
      filter: z.enum(["pending", "sent", "all"]).optional(),
      id: z.string().optional(),
      conversation_id: z.string().optional(),
      message: z.string().optional(),
      datetime: z.string().optional(),
      notification_type: z.enum(["extension", "whatsapp", "automatic"]).optional(),
      target_session: z.string().optional(),
    }),
  },
  {
    name: "manage_lists",
    description: "Manage personal chat lists: list, get, create, edit, delete, add_chat, remove_chat.",
    inputSchema: z.object({
      action: z.enum(["list", "get", "create", "edit", "delete", "add_chat", "remove_chat"]),
      id: z.string().optional(),
      name: z.string().optional(),
      conversation_id: z.union([z.string(), z.array(z.string())]).optional(),
      target_session: z.string().optional(),
    }),
  },
  {
    name: "get_api_info",
    description: "Get HTTP REST API connection info for programmatic access.",
    inputSchema: z.object({}),
  },
];

/**
 * Simple zod-to-JSON-Schema converter for the subset we use.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodValue = value as z.ZodType;
      properties[key] = zodToJsonSchema(zodValue);

      if (!(zodValue instanceof z.ZodOptional) && !(zodValue instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }

  if (schema instanceof z.ZodString) {
    return { type: "string", description: schema.description };
  }

  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: "boolean" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options, description: schema.description };
  }

  if (schema instanceof z.ZodOptional) {
    const inner = zodToJsonSchema(schema.unwrap());
    if (schema.description && !inner.description) {
      return { ...inner, description: schema.description };
    }
    return inner;
  }

  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema.removeDefault());
    const result: Record<string, unknown> = { ...inner, default: schema._def.defaultValue() };
    if (schema.description && !result.description) {
      result.description = schema.description;
    }
    return result;
  }

  if (schema instanceof z.ZodArray) {
    const result: Record<string, unknown> = { type: "array", items: zodToJsonSchema(schema.element) };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodUnion) {
    const options = (schema._def.options as z.ZodType[]).map(zodToJsonSchema);
    const result: Record<string, unknown> = { oneOf: options };
    if (schema.description) result.description = schema.description;
    return result;
  }

  return { type: "object" };
}
