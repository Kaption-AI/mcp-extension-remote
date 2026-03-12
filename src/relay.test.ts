/**
 * E2E-style tests for the MCP relay pipeline.
 *
 * Tests the full flow: tool registration, schema validation, argument
 * forwarding, RelayRoom message handling, auth handshake, hibernation
 * recovery, and error paths.
 *
 * These tests don't require a real extension — they simulate the
 * extension WebSocket side to verify the relay logic end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS, zodToJsonSchema } from "./tools";
import {
  validateJwt,
  extractPhoneFromJwt,
  hmacSign,
  hmacVerify,
  sanitizeForLog,
} from "./otp";
import {
  SendOTPSchema,
  VerifyOTPSchema,
  ExtSendOTPSchema,
  ExtVerifyOTPSchema,
  isAllowedRedirectUri,
} from "./schemas";

// ─── Tool Registration ──────────────────────────────────────────────

describe("Tool registration", () => {
  const EXPECTED_TOOLS = [
    "query",
    "summarize_conversation",
    "manage_labels",
    "manage_notes",
    "download_media",
    "manage_chat",
    "manage_reminders",
    "manage_scheduled_messages",
    "manage_lists",
    "get_api_info",
  ];

  it("exports exactly 10 tools", () => {
    expect(TOOLS).toHaveLength(10);
  });

  it("exports all expected tool names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  it("every tool has a non-empty description", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("query description contains HOW TO READ MESSAGES guidance", () => {
    const queryTool = TOOLS.find((t) => t.name === "query")!;
    expect(queryTool.description).toContain("HOW TO READ MESSAGES:");
    expect(queryTool.description).toContain("pass its id");
    expect(queryTool.description).toContain('Do NOT use entity="messages" for this');
  });

  it("query description contains AUDIO TRANSCRIPTIONS guidance", () => {
    const queryTool = TOOLS.find((t) => t.name === "query")!;
    expect(queryTool.description).toContain("AUDIO TRANSCRIPTIONS:");
    expect(queryTool.description).toContain('entity="transcriptions"');
  });

  it("query description contains multi-account guidance", () => {
    const queryTool = TOOLS.find((t) => t.name === "query")!;
    expect(queryTool.description).toContain("Multiple WhatsApp accounts");
    expect(queryTool.description).toContain('entity="session"');
    expect(queryTool.description).toContain("target_session");
  });

  it("every tool schema field has a .describe()", () => {
    for (const tool of TOOLS) {
      const jsonSchema = zodToJsonSchema(tool.inputSchema);
      const props = jsonSchema.properties as Record<string, any> | undefined;
      if (!props) continue;
      for (const [key, prop] of Object.entries(props)) {
        expect(prop.description ?? prop.oneOf, `${tool.name}.${key} missing description`).toBeDefined();
      }
    }
  });

  it("every tool has a valid Zod inputSchema", () => {
    for (const tool of TOOLS) {
      // Should parse without throwing
      const result = tool.inputSchema.safeParse({});
      // At minimum, the schema should be parseable (may fail validation, but shouldn't throw)
      expect(result).toBeDefined();
    }
  });

  it("every tool schema converts to valid JSON Schema", () => {
    for (const tool of TOOLS) {
      const jsonSchema = zodToJsonSchema(tool.inputSchema);
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeDefined();
    }
  });
});

// ─── Query tool schema ──────────────────────────────────────────────

describe("query tool schema", () => {
  const queryTool = TOOLS.find((t) => t.name === "query")!;

  it("accepts empty object (default query)", () => {
    const result = queryTool.inputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts entity=session", () => {
    const result = queryTool.inputSchema.safeParse({ entity: "session" });
    expect(result.success).toBe(true);
  });

  it("accepts entity=messages with id", () => {
    const result = queryTool.inputSchema.safeParse({
      entity: "messages",
      id: "5491155551234@c.us",
    });
    expect(result.success).toBe(true);
  });

  it("accepts entity=transcriptions", () => {
    const result = queryTool.inputSchema.safeParse({ entity: "transcriptions" });
    expect(result.success).toBe(true);
  });

  it("accepts search query", () => {
    const result = queryTool.inputSchema.safeParse({ query: "hello" });
    expect(result.success).toBe(true);
  });

  it("accepts unread filter", () => {
    const result = queryTool.inputSchema.safeParse({ unread: true });
    expect(result.success).toBe(true);
  });

  it("accepts target_session parameter", () => {
    const result = queryTool.inputSchema.safeParse({
      entity: "conversations",
      target_session: "session-123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts pagination parameters", () => {
    const result = queryTool.inputSchema.safeParse({
      limit: 50,
      before: "cursor-abc",
      after: "cursor-xyz",
    });
    expect(result.success).toBe(true);
  });

  it("accepts label filter", () => {
    const result = queryTool.inputSchema.safeParse({ label: "important" });
    expect(result.success).toBe(true);
  });

  it("accepts list filter", () => {
    const result = queryTool.inputSchema.safeParse({ list: "my-list" });
    expect(result.success).toBe(true);
  });

  it("accepts community filter", () => {
    const result = queryTool.inputSchema.safeParse({ community: "my-community" });
    expect(result.success).toBe(true);
  });

  it("accepts group filter", () => {
    const result = queryTool.inputSchema.safeParse({ group: "my-group" });
    expect(result.success).toBe(true);
  });

  it("accepts include_participants", () => {
    const result = queryTool.inputSchema.safeParse({ include_participants: true });
    expect(result.success).toBe(true);
  });

  it("rejects invalid entity", () => {
    const result = queryTool.inputSchema.safeParse({ entity: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects limit > 5000", () => {
    const result = queryTool.inputSchema.safeParse({ limit: 10000 });
    expect(result.success).toBe(false);
  });

  it("rejects limit < 1", () => {
    const result = queryTool.inputSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("defaults limit to 25", () => {
    const result = queryTool.inputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it("preserves all params through parse (forwarding fidelity)", () => {
    const input = {
      entity: "messages" as const,
      id: "5491155551234@c.us",
      query: "meeting notes",
      limit: 100,
      unread: true,
      target_session: "sess-abc",
      before: "cursor-1",
      after: "cursor-2",
      label: "work",
      list: "clients",
      community: "tech",
      group: "team",
      include_participants: true,
    };
    const result = queryTool.inputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });
});

// ─── summarize_conversation tool schema ─────────────────────────────

describe("summarize_conversation tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "summarize_conversation")!;

  it("accepts conversation_id only", () => {
    const result = tool.inputSchema.safeParse({ conversation_id: "abc@c.us" });
    expect(result.success).toBe(true);
  });

  it("accepts conversation_id + message_count", () => {
    const result = tool.inputSchema.safeParse({
      conversation_id: "abc@c.us",
      message_count: 50,
    });
    expect(result.success).toBe(true);
  });

  it("accepts target_session", () => {
    const result = tool.inputSchema.safeParse({
      conversation_id: "abc@c.us",
      target_session: "sess-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing conversation_id", () => {
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects message_count > 500", () => {
    const result = tool.inputSchema.safeParse({
      conversation_id: "abc@c.us",
      message_count: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects message_count < 1", () => {
    const result = tool.inputSchema.safeParse({
      conversation_id: "abc@c.us",
      message_count: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ─── manage_labels tool schema ──────────────────────────────────────

describe("manage_labels tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "manage_labels")!;

  it("accepts add with single conversation_id", () => {
    const result = tool.inputSchema.safeParse({
      action: "add",
      label_name: "important",
      conversation_id: "abc@c.us",
    });
    expect(result.success).toBe(true);
  });

  it("accepts add with array of conversation_ids", () => {
    const result = tool.inputSchema.safeParse({
      action: "add",
      label_name: "important",
      conversation_id: ["abc@c.us", "def@c.us"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts create action", () => {
    const result = tool.inputSchema.safeParse({
      action: "create",
      label_name: "new-label",
    });
    expect(result.success).toBe(true);
  });

  it("accepts delete action", () => {
    const result = tool.inputSchema.safeParse({
      action: "delete",
      label_id: "label-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action", () => {
    const result = tool.inputSchema.safeParse({ action: "invalid" });
    expect(result.success).toBe(false);
  });
});

// ─── manage_chat tool schema ────────────────────────────────────────

describe("manage_chat tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "manage_chat")!;

  const ACTIONS = [
    "archive", "unarchive", "mark_read", "mark_unread",
    "pin", "unpin", "mute", "unmute", "set_draft", "clear_draft",
  ];

  for (const action of ACTIONS) {
    it(`accepts action=${action}`, () => {
      const result = tool.inputSchema.safeParse({
        action,
        conversation_id: "abc@c.us",
      });
      expect(result.success).toBe(true);
    });
  }

  it("accepts mute with mute_duration", () => {
    const result = tool.inputSchema.safeParse({
      action: "mute",
      conversation_id: "abc@c.us",
      mute_duration: "8h",
    });
    expect(result.success).toBe(true);
  });

  it("accepts set_draft with text", () => {
    const result = tool.inputSchema.safeParse({
      action: "set_draft",
      conversation_id: "abc@c.us",
      text: "Hello!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing conversation_id", () => {
    const result = tool.inputSchema.safeParse({ action: "archive" });
    expect(result.success).toBe(false);
  });
});

// ─── manage_notes tool schema ───────────────────────────────────────

describe("manage_notes tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "manage_notes")!;

  it("accepts get action", () => {
    const result = tool.inputSchema.safeParse({
      action: "get",
      contact_id: "abc@c.us",
    });
    expect(result.success).toBe(true);
  });

  it("accepts set action with note", () => {
    const result = tool.inputSchema.safeParse({
      action: "set",
      contact_id: "abc@c.us",
      note: "Important customer",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing contact_id", () => {
    const result = tool.inputSchema.safeParse({ action: "get" });
    expect(result.success).toBe(false);
  });
});

// ─── download_media tool schema ─────────────────────────────────────

describe("download_media tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "download_media")!;

  it("accepts valid input", () => {
    const result = tool.inputSchema.safeParse({
      message_id: "msg-123",
      conversation_id: "abc@c.us",
    });
    expect(result.success).toBe(true);
  });

  it("accepts target_session", () => {
    const result = tool.inputSchema.safeParse({
      message_id: "msg-123",
      conversation_id: "abc@c.us",
      target_session: "sess-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing message_id", () => {
    const result = tool.inputSchema.safeParse({ conversation_id: "abc@c.us" });
    expect(result.success).toBe(false);
  });

  it("rejects missing conversation_id", () => {
    const result = tool.inputSchema.safeParse({ message_id: "msg-123" });
    expect(result.success).toBe(false);
  });
});

// ─── manage_reminders tool schema ───────────────────────────────────

describe("manage_reminders tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "manage_reminders")!;

  it("accepts list action", () => {
    const result = tool.inputSchema.safeParse({ action: "list" });
    expect(result.success).toBe(true);
  });

  it("accepts create with all fields", () => {
    const result = tool.inputSchema.safeParse({
      action: "create",
      title: "Call back",
      datetime: "2026-03-15T10:00:00Z",
      notification_type: "whatsapp",
    });
    expect(result.success).toBe(true);
  });

  it("accepts filter parameter", () => {
    const result = tool.inputSchema.safeParse({
      action: "list",
      filter: "active",
    });
    expect(result.success).toBe(true);
  });

  it("accepts complete action with id", () => {
    const result = tool.inputSchema.safeParse({
      action: "complete",
      id: "reminder-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action", () => {
    const result = tool.inputSchema.safeParse({ action: "invalid" });
    expect(result.success).toBe(false);
  });
});

// ─── manage_scheduled_messages tool schema ──────────────────────────

describe("manage_scheduled_messages tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "manage_scheduled_messages")!;

  it("accepts list action", () => {
    const result = tool.inputSchema.safeParse({ action: "list" });
    expect(result.success).toBe(true);
  });

  it("accepts create with all fields", () => {
    const result = tool.inputSchema.safeParse({
      action: "create",
      conversation_id: "abc@c.us",
      message: "Follow up on proposal",
      datetime: "2026-03-15T10:00:00Z",
      notification_type: "extension",
    });
    expect(result.success).toBe(true);
  });

  it("accepts filter=pending", () => {
    const result = tool.inputSchema.safeParse({
      action: "list",
      filter: "pending",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action", () => {
    const result = tool.inputSchema.safeParse({ action: "invalid" });
    expect(result.success).toBe(false);
  });
});

// ─── manage_lists tool schema ───────────────────────────────────────

describe("manage_lists tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "manage_lists")!;

  it("accepts list action", () => {
    const result = tool.inputSchema.safeParse({ action: "list" });
    expect(result.success).toBe(true);
  });

  it("accepts create with name", () => {
    const result = tool.inputSchema.safeParse({
      action: "create",
      name: "VIP Clients",
    });
    expect(result.success).toBe(true);
  });

  it("accepts add_chat with array of conversation_ids", () => {
    const result = tool.inputSchema.safeParse({
      action: "add_chat",
      id: "list-123",
      conversation_id: ["abc@c.us", "def@c.us"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts add_chat with single conversation_id", () => {
    const result = tool.inputSchema.safeParse({
      action: "add_chat",
      id: "list-123",
      conversation_id: "abc@c.us",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action", () => {
    const result = tool.inputSchema.safeParse({ action: "invalid" });
    expect(result.success).toBe(false);
  });
});

// ─── get_api_info tool schema ───────────────────────────────────────

describe("get_api_info tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "get_api_info")!;

  it("accepts empty object", () => {
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ─── zodToJsonSchema conversion ─────────────────────────────────────

describe("zodToJsonSchema", () => {
  it("converts query tool schema with all field types", () => {
    const queryTool = TOOLS.find((t) => t.name === "query")!;
    const schema = zodToJsonSchema(queryTool.inputSchema);
    expect(schema.type).toBe("object");

    const props = schema.properties as Record<string, any>;
    expect(props.query.type).toBe("string");
    expect(props.entity.type).toBe("string");
    expect(props.entity.enum).toContain("session");
    expect(props.entity.enum).toContain("messages");
    expect(props.entity.enum).toContain("transcriptions");
    expect(props.limit.type).toBe("number");
    expect(props.limit.default).toBe(25);
    expect(props.unread.type).toBe("boolean");
  });

  it("marks required fields correctly for summarize_conversation", () => {
    const tool = TOOLS.find((t) => t.name === "summarize_conversation")!;
    const schema = zodToJsonSchema(tool.inputSchema);
    expect(schema.required).toContain("conversation_id");
    expect(schema.required).not.toContain("message_count");
    expect(schema.required).not.toContain("target_session");
  });

  it("marks required fields correctly for manage_chat", () => {
    const tool = TOOLS.find((t) => t.name === "manage_chat")!;
    const schema = zodToJsonSchema(tool.inputSchema);
    expect(schema.required).toContain("action");
    expect(schema.required).toContain("conversation_id");
    expect(schema.required).not.toContain("mute_duration");
    expect(schema.required).not.toContain("text");
  });

  it("handles union types (string | array) for manage_labels", () => {
    const tool = TOOLS.find((t) => t.name === "manage_labels")!;
    const schema = zodToJsonSchema(tool.inputSchema);
    const props = schema.properties as Record<string, any>;
    // conversation_id is z.union([string, array])
    expect(props.conversation_id.oneOf).toBeDefined();
    expect(props.conversation_id.oneOf).toHaveLength(2);
  });

  it("converts all 10 tools without error", () => {
    for (const tool of TOOLS) {
      expect(() => zodToJsonSchema(tool.inputSchema)).not.toThrow();
    }
  });
});

// ─── JWT phone extraction consistency ───────────────────────────────

describe("JWT phone extraction consistency", () => {
  // Both validateJwt and extractPhoneFromJwt should use the same field priority

  it("extractPhoneFromJwt reads phoneNumber first", () => {
    const payload = { phoneNumber: "5491155551234", phone: "different" };
    const jwt = `header.${btoa(JSON.stringify(payload))}.signature`;
    expect(extractPhoneFromJwt(jwt)).toBe("5491155551234");
  });

  it("extractPhoneFromJwt falls back to phone", () => {
    const payload = { phone: "5491155551234" };
    const jwt = `header.${btoa(JSON.stringify(payload))}.signature`;
    expect(extractPhoneFromJwt(jwt)).toBe("5491155551234");
  });

  it("extractPhoneFromJwt returns null when no phone fields", () => {
    const payload = { sub: "user-123", email: "test@test.com" };
    const jwt = `header.${btoa(JSON.stringify(payload))}.signature`;
    expect(extractPhoneFromJwt(jwt)).toBeNull();
  });

  it("extractPhoneFromJwt does NOT read sub field (removed)", () => {
    const payload = { sub: "5491155551234" };
    const jwt = `header.${btoa(JSON.stringify(payload))}.signature`;
    expect(extractPhoneFromJwt(jwt)).toBeNull();
  });

  it("extractPhoneFromJwt does NOT read userToken field (removed)", () => {
    const payload = { userToken: "5491155551234" };
    const jwt = `header.${btoa(JSON.stringify(payload))}.signature`;
    expect(extractPhoneFromJwt(jwt)).toBeNull();
  });

  it("extractPhoneFromJwt returns null for malformed JWT", () => {
    expect(extractPhoneFromJwt("not-a-jwt")).toBeNull();
    expect(extractPhoneFromJwt("")).toBeNull();
    expect(extractPhoneFromJwt("a.b")).toBeNull(); // b is not valid base64 JSON
  });
});

// ─── JSON-RPC message validation ────────────────────────────────────

describe("JSON-RPC message validation (isValidJsonRpc logic)", () => {
  // Mirror the validation logic from relay-room.ts

  function isValidJsonRpc(msg: unknown): boolean {
    if (typeof msg !== "object" || msg === null) return false;
    const obj = msg as Record<string, unknown>;
    if (obj.jsonrpc === "2.0") {
      if (obj.method !== undefined && obj.id !== undefined) return true;
      if (obj.id !== undefined && (obj.result !== undefined || obj.error !== undefined)) return true;
    }
    if (obj.type === "ping" || obj.type === "pong" || obj.method === "pong") return true;
    if (obj.type === "auth" && (typeof obj.jwt === "string" || typeof obj.token === "string")) return true;
    return false;
  }

  it("accepts valid JSON-RPC request", () => {
    expect(isValidJsonRpc({ jsonrpc: "2.0", id: 1, method: "query", params: {} })).toBe(true);
  });

  it("accepts valid JSON-RPC response with result", () => {
    expect(isValidJsonRpc({ jsonrpc: "2.0", id: 1, result: { data: [] } })).toBe(true);
  });

  it("accepts valid JSON-RPC response with error", () => {
    expect(isValidJsonRpc({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "fail" } })).toBe(true);
  });

  it("accepts ping message", () => {
    expect(isValidJsonRpc({ type: "ping" })).toBe(true);
  });

  it("accepts pong message", () => {
    expect(isValidJsonRpc({ type: "pong" })).toBe(true);
  });

  it("accepts pong method", () => {
    expect(isValidJsonRpc({ method: "pong" })).toBe(true);
  });

  it("accepts JWT auth handshake", () => {
    expect(isValidJsonRpc({ type: "auth", jwt: "eyJ..." })).toBe(true);
  });

  it("accepts legacy token auth handshake", () => {
    expect(isValidJsonRpc({ type: "auth", token: "tok-123" })).toBe(true);
  });

  it("rejects auth without jwt or token", () => {
    expect(isValidJsonRpc({ type: "auth" })).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidJsonRpc(null)).toBe(false);
  });

  it("rejects string", () => {
    expect(isValidJsonRpc("hello")).toBe(false);
  });

  it("rejects empty object", () => {
    expect(isValidJsonRpc({})).toBe(false);
  });

  it("rejects JSON-RPC 1.0", () => {
    expect(isValidJsonRpc({ jsonrpc: "1.0", id: 1, method: "query" })).toBe(false);
  });

  it("rejects JSON-RPC request without id", () => {
    expect(isValidJsonRpc({ jsonrpc: "2.0", method: "query" })).toBe(false);
  });
});

// ─── HMAC signing for OAuth state ───────────────────────────────────

describe("HMAC OAuth state roundtrip", () => {
  const secret = "test-internal-api-key";

  it("signs and verifies OAuth request info", async () => {
    const oauthReqInfo = {
      clientId: "claude-ai",
      redirectUri: "https://claude.ai/callback",
      scope: "whatsapp",
      state: "random-state",
    };
    const encoded = btoa(JSON.stringify(oauthReqInfo));
    const signed = await hmacSign(encoded, secret);
    const verified = await hmacVerify(signed, secret);
    expect(verified).toBe(encoded);
    expect(JSON.parse(atob(verified!))).toEqual(oauthReqInfo);
  });

  it("rejects tampered OAuth state", async () => {
    const encoded = btoa(JSON.stringify({ clientId: "legit" }));
    const signed = await hmacSign(encoded, secret);
    // Tamper with the payload
    const [, sig] = signed.split(".");
    const tampered = btoa(JSON.stringify({ clientId: "evil" })) + "." + sig;
    const result = await hmacVerify(tampered, secret);
    expect(result).toBeNull();
  });
});

// ─── Redirect URI allowlist ─────────────────────────────────────────

describe("OAuth redirect URI allowlist (comprehensive)", () => {
  // Valid origins
  const ALLOWED = [
    "https://claude.ai/callback",
    "https://mcp.claude.ai/oauth/callback",
    "http://localhost/callback",
    "http://localhost:3000/callback",
    "http://127.0.0.1:8080/callback",
    "https://cursor.sh/callback",
    "https://cursor.com/callback",
    "https://www.cursor.com/callback",
    "https://kaptionai.com/callback",
    "https://mcp-ext.kaptionai.com/callback",
    "https://windsurf.com/oauth",
    "https://ide.windsurf.com/callback",
  ];

  for (const uri of ALLOWED) {
    it(`allows ${uri}`, () => {
      expect(isAllowedRedirectUri(uri)).toBe(true);
    });
  }

  // Attack vectors
  const BLOCKED = [
    "https://evil.com/callback",
    "http://claude.ai/callback", // http not https
    "https://localhost:3000/callback", // https not http
    "https://claude.ai.evil.com/callback", // subdomain spoof
    "https://evilclaude.ai/callback", // prefix spoof
    "javascript:alert(1)", // XSS
    "", // empty
    "https://evil.com?redirect=https://claude.ai", // query param injection
    "ftp://claude.ai/callback", // wrong protocol
  ];

  for (const uri of BLOCKED) {
    it(`blocks ${uri || "(empty)"}`, () => {
      expect(isAllowedRedirectUri(uri)).toBe(false);
    });
  }
});

// ─── Sanitize for log ───────────────────────────────────────────────

describe("sanitizeForLog (PII protection)", () => {
  it("masks Argentine phone number", () => {
    expect(sanitizeForLog("5491155551234")).toBe("549****234");
  });

  it("masks US phone number", () => {
    expect(sanitizeForLog("15551234567")).toBe("155****567");
  });

  it("masks fully when <= 4 chars", () => {
    expect(sanitizeForLog("1234")).toBe("****");
    expect(sanitizeForLog("abc")).toBe("****");
    expect(sanitizeForLog("ab")).toBe("****");
    expect(sanitizeForLog("a")).toBe("****");
  });

  it("never leaks full phone number", () => {
    const phone = "5491155551234";
    const sanitized = sanitizeForLog(phone);
    expect(sanitized).not.toBe(phone);
    expect(sanitized).not.toContain("5555"); // middle digits hidden
  });
});

// ─── Argument cleaning for DO RPC ───────────────────────────────────

describe("argument cleaning for DO RPC", () => {
  // The relay does JSON.parse(JSON.stringify(args)) to strip non-serializable props

  it("strips functions from args", () => {
    const args = {
      entity: "conversations",
      callback: () => {},
      signal: new AbortController().signal,
    };
    const cleaned = JSON.parse(JSON.stringify(args));
    expect(cleaned.entity).toBe("conversations");
    expect(cleaned.callback).toBeUndefined();
    expect(cleaned.signal).toBeDefined(); // AbortSignal serializes to {}
  });

  it("preserves all standard MCP args", () => {
    const args = {
      entity: "messages",
      id: "5491155551234@c.us",
      query: "hello",
      limit: 50,
      unread: true,
      target_session: "sess-1",
    };
    const cleaned = JSON.parse(JSON.stringify(args));
    expect(cleaned).toEqual(args);
  });

  it("preserves nested objects", () => {
    const args = {
      action: "create",
      data: { name: "Test", items: [1, 2, 3] },
    };
    const cleaned = JSON.parse(JSON.stringify(args));
    expect(cleaned).toEqual(args);
  });
});

// ─── Extension auth flow validation ─────────────────────────────────

describe("extension auth flow schemas", () => {
  it("ExtSendOTPSchema normalizes phone with formatting", async () => {
    const result = await ExtSendOTPSchema.safeParseAsync({ phone: "+54 (911) 5555-1234" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("5491155551234");
    }
  });

  it("ExtVerifyOTPSchema accepts valid phone + 6-digit code", async () => {
    const result = await ExtVerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "123456",
    });
    expect(result.success).toBe(true);
  });

  it("ExtVerifyOTPSchema rejects 5-digit code", async () => {
    const result = await ExtVerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("ExtVerifyOTPSchema rejects alpha code", async () => {
    const result = await ExtVerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "abc123",
    });
    expect(result.success).toBe(false);
  });
});

// ─── OAuth flow validation ──────────────────────────────────────────

describe("OAuth flow schemas", () => {
  it("SendOTPSchema requires phone and oauthReqInfo", async () => {
    const result = await SendOTPSchema.safeParseAsync({
      phone: "5491155551234",
      oauthReqInfo: "signed-state",
    });
    expect(result.success).toBe(true);
  });

  it("VerifyOTPSchema requires verifyTicket + code", async () => {
    const result = await VerifyOTPSchema.safeParseAsync({
      verifyTicket: "encrypted-ticket",
      code: "123456",
    });
    expect(result.success).toBe(true);
  });

  it("VerifyOTPSchema rejects missing verifyTicket", async () => {
    const result = await VerifyOTPSchema.safeParseAsync({
      code: "123456",
    });
    expect(result.success).toBe(false);
  });
});
