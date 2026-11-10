/**
 * mcp-manage-kaption.LIST.1-2, HELP.3, PROMPTS.2, UI.1-3 — the five "manage Kaption" tools on the cloud relay: the
 * room keeps the features of the extension's auth message, each MCP session (RelayMCP) lists the tools only while
 * the extension that answers its calls said its family is on (unknown = hidden), list_changed when that changes,
 * the guides and prompts as resources and prompts, the plans UI resource and kaption_plans' structuredContent.
 */
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

vi.mock("agents/mcp", () => ({
  McpAgent: class McpAgent {
    props: unknown;
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

vi.mock("./otp", () => ({
  validateJwt: vi.fn(async () => "15555550123"),
  deriveAccountRef: vi.fn(async () => "acct_test"),
  validateExtensionSession: vi.fn(async () => null),
  sanitizeAccountRefForLog: (ref: string) => ref,
  normalizeAndValidatePhone: (p: string) => p,
}));

import { RelayMCP } from "./relay-mcp";
import { RelayRoom } from "./relay-room";
import { MANAGE_KAPTION_TOOLS, readManageFeatures, visibleManageTools, type ManageFeatures } from "./manage-kaption";
import { PLANS_UI_HTML } from "./plans-ui";
import { TOOLS, getToolsForMCP } from "./tools";
import channelsCanonical from "./test-support/mcp-channels-communities-tools.json";
import { FakeKV } from "./test-support/fake-kv";

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const PLANS_ANSWER = {
  currency: "USD",
  periods: ["yearly", "quarterly", "monthly"],
  default_period: "yearly",
  methods: ["card"],
  labels: { title: "Plans", per_month: "/ month", periods: { yearly: "Yearly" }, pay_note: "You pay on the checkout page." },
  plans: [{ id: "pro", name: "Pro", state: "available", badge: null, prices: {}, trial: null, highlights_label: "", highlights: [], features: [], button: "Subscribe", checkout: true, alipay: false, note: null }],
  message: "Here are the plans.",
};

/** The account's relay room as RelayMCP sees it over RPC: its features and the extension's answers. */
function fakeRoom(features: ManageFeatures | null) {
  const room = {
    features,
    watchers: [] as string[],
    calls: [] as Array<{ method: string; params: any }>,
    unreachable: false,
    async watchManage(id: string) {
      room.watchers.push(id);
      return room.features;
    },
    async handleMcpRequestSettled(method: string, params: any) {
      room.calls.push({ method, params });
      if (room.unreachable) return { ok: false, message: "Extension not connected. Open WhatsApp Web", code: "offline" };
      if (method === "kaption_help" && params.action === "list") {
        return { ok: true, result: { topics: [{ id: "pricing", title: "Plans and prices", summary: "What each plan costs" }], count: 1 } };
      }
      if (method === "kaption_help" && params.action === "read") {
        return params.topic === "pricing"
          ? { ok: true, result: { id: "pricing", title: "Plans and prices", text: "# Plans" } }
          : { ok: false, message: "unknown topic", code: -32602 };
      }
      if (method === "kaption_help" && params.action === "prompts") {
        return { ok: true, result: { language: "en", prompts: [{ id: "summarize-day", group: "daily", title: "Summarize my day", text: "Summarize today." }] } };
      }
      if (method === "kaption_plans") return { ok: true, result: PLANS_ANSWER };
      return { ok: true, result: { ok: true } };
    },
  };
  return room;
}

async function session(room: ReturnType<typeof fakeRoom>) {
  const env = {
    OAUTH_KV: new FakeKV(),
    USAGE_LEDGER_ENABLED: "off",
    RELAY_ROOM: { idFromName: (name: string) => name, get: () => room },
  };
  const ctx = { id: { toString: () => "ab".repeat(32) }, waitUntil: () => undefined };
  const agent = new RelayMCP(ctx as any, env as any);
  (agent as any).props = { accountRef: "acct_test" };
  await agent.init();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await (agent as any).server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);
  const changed = { tools: 0, resources: 0, prompts: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed.tools++; });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => { changed.resources++; });
  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => { changed.prompts++; });
  const manage = async () => (await client.listTools()).tools.map((t) => t.name).filter((n) => MANAGE_KAPTION_TOOLS.includes(n));
  return { agent, client, manage, changed };
}

describe("mcp-manage-kaption.LIST.2 the rule", () => {
  it("some account true shows; nothing said, a missing key or a non-boolean hides", () => {
    expect([...visibleManageTools([null])]).toEqual([]);
    expect([...visibleManageTools([{}])]).toEqual([]);
    expect([...visibleManageTools([{ manage_kaption: true }])]).toEqual(["get_kaption_settings", "update_kaption_settings", "reconnect_kaption_connection", "kaption_help", "report_bug"]);
    expect([...visibleManageTools([{ business_agent: true, plans: true }])]).toEqual(["get_business_agent", "manage_business_agent", "kaption_plans", "create_kaption_checkout_link"]);
    expect(readManageFeatures({ manage_kaption: "yes", plans: true, local_send: false })).toEqual({ plans: true });
    // scheduled-status.MCP — the status tools follow their own key.
    expect([...visibleManageTools([{ scheduled_status: true }])]).toEqual(["manage_status", "list_status_posts"]);
    expect([...visibleManageTools([{ manage_kaption: true, business_agent: true, plans: true }])]).not.toContain("manage_status");
    expect(readManageFeatures({ scheduled_status: true, other: true })).toEqual({ scheduled_status: true });
    expect(readManageFeatures({ scheduled_status: "true" })).toEqual({});
  });
});

describe("scheduled-status.MCP the status tools on the relay", () => {
  it("hidden for an older extension (no scheduled_status key) and when it is false", async () => {
    for (const features of [{}, { manage_kaption: true, plans: true }, { scheduled_status: false }]) {
      const names = (await (await session(fakeRoom(features))).client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("manage_status");
      expect(names).not.toContain("list_status_posts");
      expect(names).toContain("query");
    }
  });

  it("listed with scheduled_status true: manage_status writes, list_status_posts reads", async () => {
    const s = await session(fakeRoom({ scheduled_status: true }));
    const tools = (await s.client.listTools()).tools;
    expect(await s.manage()).toEqual(["manage_status", "list_status_posts"]);
    const manage = tools.find((t) => t.name === "manage_status")!;
    const list = tools.find((t) => t.name === "list_status_posts")!;
    expect((manage.inputSchema.properties as any).action.enum).toEqual(["schedule", "cancel"]);
    expect(manage.annotations).toMatchObject({ title: "Schedule a WhatsApp status", readOnlyHint: false, destructiveHint: true });
    expect(list.annotations).toMatchObject({ title: "List status posts", readOnlyHint: true, destructiveHint: false });
    expect(manage.description).not.toMatch(/post_now/);
  });

  it("a hidden status tool never reaches the extension; a visible one is relayed (list as manage_status list)", async () => {
    const hiddenRoom = fakeRoom({ manage_kaption: true });
    const hidden: any = await (await session(hiddenRoom)).client.callTool({ name: "manage_status", arguments: { action: "cancel", id: "s1" } });
    expect(hidden.isError).toBe(true);
    expect(hiddenRoom.calls).toEqual([]);

    const room = fakeRoom({ scheduled_status: true });
    const s = await session(room);
    const listed: any = await s.client.callTool({ name: "list_status_posts", arguments: { filter: "all" } });
    expect(listed.isError).toBeFalsy();
    const cancelled: any = await s.client.callTool({ name: "manage_status", arguments: { action: "cancel", id: "s1" } });
    expect(cancelled.isError).toBeFalsy();
    expect(room.calls).toEqual([
      { method: "manage_status", params: { filter: "all", action: "list" } },
      { method: "manage_status", params: { action: "cancel", id: "s1" } },
    ]);
  });

  it("post_now is not an action", async () => {
    const s = await session(fakeRoom({ scheduled_status: true }));
    const res: any = await s.client.callTool({ name: "manage_status", arguments: { action: "post_now", text: "Hi" } });
    expect(res.isError).toBe(true);
  });
});

const CHANNEL_TOOLS = ["manage_channels", "manage_communities", "list_channels", "get_channel", "list_communities", "get_community"];

// The relay's object schemas carry additionalProperties: false and the SDK adds $schema and lists a union as anyOf.
function normalized(v: any): any {
  if (Array.isArray(v)) return v.map(normalized);
  if (!v || typeof v !== "object") return v;
  const out: any = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === "additionalProperties" && x === false) || k === "$schema") continue;
    out[k === "anyOf" ? "oneOf" : k] = normalized(x);
  }
  return out;
}

describe("whatsapp-channels-communities.HUB the channels and communities tools on the relay", () => {
  it("HUB.2 are the pinned kaptionai definitions, verbatim", async () => {
    expect(TOOLS.slice(-CHANNEL_TOOLS.length).map((t) => t.name)).toEqual(channelsCanonical.map((t: any) => t.name));
    const exported = getToolsForMCP();
    for (const want of channelsCanonical as any[]) {
      const got = exported.find((t) => t.name === want.name)!;
      expect({ name: got.name, title: got.title, description: got.description, inputSchema: normalized(got.inputSchema), annotations: got.annotations }).toEqual(want);
    }
    const listed = (await (await session(fakeRoom({ channels_communities: true }))).client.listTools()).tools;
    for (const want of channelsCanonical as any[]) {
      const got = listed.find((t) => t.name === want.name)!;
      expect(got.title).toBe(want.title);
      expect(got.description).toBe(want.description);
      expect(got.annotations).toEqual(want.annotations);
      expect(normalized(got.inputSchema)).toEqual(want.inputSchema);
    }
  });

  it("HUB.1 the key: only channels_communities true shows them", () => {
    expect([...visibleManageTools([{ channels_communities: true }])]).toEqual(CHANNEL_TOOLS);
    expect([...visibleManageTools([{ manage_kaption: true, business_agent: true, plans: true, scheduled_status: true }])].filter((n) => CHANNEL_TOOLS.includes(n))).toEqual([]);
    expect(readManageFeatures({ channels_communities: true, local_send: true })).toEqual({ channels_communities: true });
    expect(readManageFeatures({ channels_communities: "true" })).toEqual({});
  });

  it("HUB.1 hidden for an older extension (no key) and when it is false; listed when true", async () => {
    for (const features of [{}, { manage_kaption: true, scheduled_status: true }, { channels_communities: false }]) {
      const names = (await (await session(fakeRoom(features))).client.listTools()).tools.map((t) => t.name);
      for (const name of CHANNEL_TOOLS) expect(names).not.toContain(name);
      expect(names).toContain("query");
    }
    expect(await (await session(fakeRoom({ channels_communities: true }))).manage()).toEqual(CHANNEL_TOOLS);
  });

  it("follows a change of the feature with list_changed", async () => {
    const room = fakeRoom({ manage_kaption: true });
    const s = await session(room);
    room.features = { manage_kaption: true, channels_communities: true };
    await s.agent.refreshManageVisibility();
    await flush();
    expect(await s.manage()).toEqual([...visibleManageTools([{ manage_kaption: true }]), ...CHANNEL_TOOLS]);
    expect(s.changed.tools).toBeGreaterThan(0);
  });

  it("MCP_ROUTES.3 reads are relayed as manage_* list / get; writes as is; a hidden one never reaches the extension", async () => {
    const hiddenRoom = fakeRoom({ manage_kaption: true, scheduled_status: true });
    const hidden: any = await (await session(hiddenRoom)).client.callTool({ name: "list_channels", arguments: {} });
    expect(hidden.isError).toBe(true);
    expect(hiddenRoom.calls).toEqual([]);

    const room = fakeRoom({ channels_communities: true });
    const s = await session(room);
    const cross = { action: "cross_post", text: "Closed", targets: ["1@newsletter", { id: "2@g.us", text: "Closed Friday" }] };
    const digest = { action: "digest", id: "2@g.us", since: "2026-11-08T00:00:00-03:00" };
    for (const [name, args] of [
      ["list_channels", {}], ["get_channel", { id: "1@newsletter" }], ["list_communities", {}], ["get_community", { id: "2@g.us" }],
      ["manage_channels", cross], ["manage_communities", digest],
    ] as Array<[string, Record<string, unknown>]>) {
      const res: any = await s.client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
    expect(room.calls).toEqual([
      { method: "manage_channels", params: { action: "list" } },
      { method: "manage_channels", params: { id: "1@newsletter", action: "get" } },
      { method: "manage_communities", params: { action: "list" } },
      { method: "manage_communities", params: { id: "2@g.us", action: "get" } },
      { method: "manage_channels", params: cross },
      { method: "manage_communities", params: digest },
    ]);
  });

  it("refuses unknown actions and more than 14 posts / 10 targets / 20 groups before the extension", async () => {
    const room = fakeRoom({ channels_communities: true });
    const s = await session(room);
    const post = { text: "x", datetime: "2026-11-16T09:00:00-03:00" };
    for (const [name, args] of [
      ["manage_channels", { action: "delete", id: "a@newsletter" }],
      ["manage_channels", { action: "schedule", id: "a@newsletter", posts: Array(15).fill(post) }],
      ["manage_channels", { action: "cross_post", text: "x", targets: Array(11).fill("a@newsletter") }],
      ["manage_communities", { action: "add_groups", id: "c@g.us", group_ids: Array(21).fill("g@g.us") }],
      ["get_community", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const res: any = await s.client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
    }
    expect(room.calls).toEqual([]);
  });
});

describe("mcp-manage-kaption.LIST.2 an MCP session lists the manage tools from its extension's features", () => {
  it("hidden for an extension that said nothing, or when none is connected", async () => {
    expect(await (await session(fakeRoom({}))).manage()).toEqual([]);
    const offline = await session(fakeRoom(null));
    expect(await offline.manage()).toEqual([]);
    expect((await offline.client.listTools()).tools.map((t) => t.name)).toContain("query");
  });

  it("shows each family said true, and follows a change with list_changed", async () => {
    const room = fakeRoom({ manage_kaption: true });
    const s = await session(room);
    expect(room.watchers).toEqual(["ab".repeat(32)]);
    expect(await s.manage()).toEqual(["get_kaption_settings", "update_kaption_settings", "reconnect_kaption_connection", "kaption_help", "report_bug"]);

    room.features = { manage_kaption: true, business_agent: true, plans: true, scheduled_status: true, channels_communities: true };
    await s.agent.refreshManageVisibility();
    await flush();
    expect(await s.manage()).toEqual(MANAGE_KAPTION_TOOLS);
    expect(s.changed.tools).toBeGreaterThan(0);

    const before = { ...s.changed };
    room.features = { plans: true };
    await s.agent.refreshManageVisibility();
    await flush();
    expect(await s.manage()).toEqual(["kaption_plans", "create_kaption_checkout_link"]);
    expect(s.changed.tools).toBeGreaterThan(before.tools);
    expect(s.changed.resources).toBeGreaterThan(before.resources);
    expect(s.changed.prompts).toBeGreaterThan(before.prompts);
  });

  it("a call to a hidden tool answers the usual unknown-tool error and never reaches the extension", async () => {
    const room = fakeRoom({ plans: true });
    const s = await session(room);
    const hidden: any = await s.client.callTool({ name: "get_kaption_settings", arguments: {} });
    const unknown: any = await s.client.callTool({ name: "no_such_tool", arguments: {} });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).toBe(unknown.content[0].text.replace("no_such_tool", "get_kaption_settings"));
    expect(room.calls).toEqual([]);
  });

  it("a visible tool is relayed like any other", async () => {
    const room = fakeRoom({ manage_kaption: true });
    const s = await session(room);
    const res: any = await s.client.callTool({ name: "update_kaption_settings", arguments: { id: "transcription.automatic", value: false } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ result: { ok: true } });
    expect(room.calls).toEqual([{ method: "update_kaption_settings", params: { id: "transcription.automatic", value: false } }]);
  });
});

describe("mcp-manage-kaption.UI.1-2 kaption_plans", () => {
  it("links the plans page and answers its JSON as structuredContent", async () => {
    const s = await session(fakeRoom({ plans: true }));
    const tool = (await s.client.listTools()).tools.find((t) => t.name === "kaption_plans")!;
    expect(tool._meta).toMatchObject({ ui: { resourceUri: "ui://kaption/plans.html" }, "openai/outputTemplate": "ui://kaption/plans.html" });
    const res: any = await s.client.callTool({ name: "kaption_plans", arguments: {} });
    expect(res.structuredContent).toEqual(PLANS_ANSWER);
    expect(JSON.parse(res.content[0].text)).toEqual(PLANS_ANSWER);
  });

  it("serves the page with the MCP Apps mime type while kaption_plans is listed", async () => {
    const s = await session(fakeRoom({ plans: true }));
    expect((await s.client.listResources()).resources).toEqual([
      expect.objectContaining({ uri: "ui://kaption/plans.html", mimeType: "text/html;profile=mcp-app" }),
    ]);
    const read: any = await s.client.readResource({ uri: "ui://kaption/plans.html" });
    expect(read.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app", text: PLANS_UI_HTML });
    expect(PLANS_UI_HTML).not.toMatch(/US\$|R\$|€|\$ ?\d/);
    expect(PLANS_UI_HTML).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//);
  });
});

describe("mcp-manage-kaption.HELP.3, PROMPTS.2 guides and prompts", () => {
  it("lists and reads the guides and prompts through kaption_help", async () => {
    const room = fakeRoom({ manage_kaption: true });
    const s = await session(room);
    expect(s.client.getServerCapabilities()).toMatchObject({ resources: { listChanged: true }, prompts: { listChanged: true } });
    expect((await s.client.listResources()).resources).toEqual([
      { uri: "kaption://guide/pricing", name: "pricing", title: "Plans and prices", description: "What each plan costs", mimeType: "text/markdown" },
    ]);
    expect((await s.client.readResource({ uri: "kaption://guide/pricing" })).contents).toEqual([
      { uri: "kaption://guide/pricing", mimeType: "text/markdown", text: "# Plans" },
    ]);
    await expect(s.client.readResource({ uri: "kaption://guide/nope" })).rejects.toThrow(/unknown topic/);
    expect((await s.client.listPrompts()).prompts).toEqual([{ name: "summarize-day", title: "Summarize my day", description: "Summarize my day" }]);
    expect((await s.client.getPrompt({ name: "summarize-day" })).messages).toEqual([
      { role: "user", content: { type: "text", text: "Summarize today." } },
    ]);
    expect(room.calls.map((c) => c.params.action)).toEqual(["list", "read", "read", "prompts", "prompts"]);
  });

  it("answers empty lists when hidden or when the extension can't be reached", async () => {
    const hidden = await session(fakeRoom({}));
    expect((await hidden.client.listResources()).resources).toEqual([]);
    expect((await hidden.client.listPrompts()).prompts).toEqual([]);
    await expect(hidden.client.getPrompt({ name: "summarize-day" })).rejects.toThrow(/not found/);

    const room = fakeRoom({ manage_kaption: true });
    const unreachable = await session(room);
    room.unreachable = true;
    expect((await unreachable.client.listResources()).resources).toEqual([]);
    expect((await unreachable.client.listPrompts()).prompts).toEqual([]);
  });
});

// ─── The room ─────────────────────────────────────────────────────────

function socket(attachment: unknown = null) {
  return {
    sent: [] as string[],
    attachment,
    send(data: string) { this.sent.push(data); },
    close() {},
    serializeAttachment(value: unknown) { this.attachment = value; },
    deserializeAttachment() { return this.attachment; },
  };
}

function storage() {
  const map = new Map<string, unknown>();
  return { map, get: async (k: string) => map.get(k), put: async (k: string, v: unknown) => { map.set(k, v); } };
}

describe("mcp-manage-kaption.LIST.1 the room keeps the auth message's features", () => {
  it("answers the serving client's features; tells watching sessions when the listed tools change", async () => {
    const sockets = [socket({ authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() })];
    const work: Promise<unknown>[] = [];
    const refreshed: string[] = [];
    const store = storage();
    const ctx = { getWebSockets: () => sockets, acceptWebSocket: () => undefined, storage: store, waitUntil: (p: Promise<unknown>) => work.push(p) };
    const env = {
      JWT_SECRET: "x",
      PHONE_REF_SECRET: "y",
      OAUTH_KV: new FakeKV(),
      MCP_OBJECT: {
        idFromString: (id: string) => id,
        get: (id: string) => ({
          refreshManageVisibility: async () => {
            if (id === "dead".repeat(8)) throw new Error("gone");
            refreshed.push(id);
          },
        }),
      },
    };
    const r = new RelayRoom(ctx as any, env as any);
    expect(r.manageFeatures()).toBeNull();
    expect(await r.watchManage("ab".repeat(32))).toBeNull();
    expect(await r.watchManage("dead".repeat(8))).toBeNull();
    expect(await r.watchManage("not a durable object id")).toBeNull();
    expect(Object.keys(store.map.get("manage-watchers") as object).sort()).toEqual(["ab".repeat(32), "dead".repeat(8)]);

    await r.webSocketMessage(sockets[0] as any, JSON.stringify({ type: "auth", jwt: "a.b.c", features: { local_send: true, manage_kaption: true, plans: "yes" } }));
    await flush();
    await Promise.all(work);
    expect(sockets[0].attachment).toMatchObject({ authenticated: true, features: { manage_kaption: true } });
    expect(r.manageFeatures()).toEqual({ manage_kaption: true });
    expect(refreshed).toEqual(["ab".repeat(32)]);
    // A session that no longer exists is forgotten.
    expect(Object.keys(store.map.get("manage-watchers") as object)).toEqual(["ab".repeat(32)]);

    // The same features again: nobody is told.
    await r.webSocketMessage(sockets[0] as any, JSON.stringify({ type: "auth", jwt: "a.b.c", features: { manage_kaption: true } }));
    await flush();
    await Promise.all(work);
    expect(refreshed).toEqual(["ab".repeat(32)]);

    // The extension leaves: the tools go, and the session is told.
    await r.webSocketClose(sockets[0] as any);
    await flush();
    await Promise.all(work);
    expect(refreshed).toEqual(["ab".repeat(32), "ab".repeat(32)]);
  });

  it("an extension that sends no features is kept as having said nothing", async () => {
    const s = socket({ authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() });
    const r = new RelayRoom({ getWebSockets: () => [s], acceptWebSocket: () => undefined } as any, { JWT_SECRET: "x", PHONE_REF_SECRET: "y", OAUTH_KV: new FakeKV() } as any);
    await r.webSocketMessage(s as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    expect((s.attachment as any).features).toBeUndefined();
    expect(r.manageFeatures()).toEqual({});
  });
});
