/**
 * mcp-apps-cards.FLAG.1-5, DATA.1-4, SENT.3 — the cloud relay with MCP_APPS_CARDS off (nothing changes) and on (the
 * card tools link the cards page and allow a card in their outputSchema, results carry it beside result, the text
 * stays), the relay's own switch, and the flags worker lookup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

vi.mock("agents/mcp", () => ({
  McpAgent: class McpAgent {
    props: unknown;
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

vi.mock("./otp", () => ({
  validateJwt: vi.fn(async () => "17374202658"),
  deriveAccountRef: vi.fn(async () => "acct_test"),
  validateExtensionSession: vi.fn(async () => null),
  sanitizeAccountRefForLog: (ref: string) => ref,
  normalizeAndValidatePhone: (p: string) => p,
}));

import { RelayMCP } from "./relay-mcp";
import { AVATARS_TOOL, CARD_TOOLS, CARDS_UI_URI } from "./cards";
import { CARDS_UI_HTML } from "./cards-ui";
import { CARDS_FLAG_TTL_MS, cardsOnForPhone, clearCardsFlagCache, flagOn } from "./cards-flag";
import { FakeKV } from "./test-support/fake-kv";
import answers from "./test-support/mcp-apps-cards-answers.json";

const A: any = answers;
const PIC = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const roomCalls: string[] = [];
const roomParams: any[] = [];
let avatarsDown = false;

function fakeRoom(phone: string | null) {
  return {
    async watchManage() {
      return null;
    },
    async meteringPhone() {
      return phone;
    },
    async handleMcpRequestSettled(method: string, params: any) {
      roomParams.push(params);
      if (method === "query") return { ok: true, result: A.search };
      if (method === "send_message") {
        return params.message === "refuse"
          ? { ok: false, message: A.refusal_text.replace(/^Error: /, ""), code: -32602 }
          : { ok: true, result: A.sent_read };
      }
      roomCalls.push(method);
      if (method === "get_avatars") {
        if (avatarsDown) return { ok: false, message: "Unknown method", code: -32601 };
        return { ok: true, result: { avatars: { "5511987654821@c.us": PIC, "5511987654822@c.us": null, "5511987654823@c.us": "https://pps.whatsapp.net/x.jpg" } } };
      }
      if (method === "manage_scheduled_messages") return { ok: true, result: params.action === "list" ? A.scheduled_list : A.scheduled_get };
      return { ok: true, result: { ok: true } };
    },
  };
}

let flagsOn = true;
const flagCalls: string[] = [];

beforeEach(() => {
  clearCardsFlagCache();
  flagCalls.length = 0;
  roomCalls.length = 0;
  avatarsDown = false;
  flagsOn = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    flagCalls.push(String(url));
    return new Response(JSON.stringify({ flags: [{ name: "MCP_APPS_CARDS", enabled: false, remoteEnabled: flagsOn }] }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function session(opts: { switch?: string; phone?: string | null } = {}) {
  const env = {
    OAUTH_KV: new FakeKV(),
    USAGE_LEDGER_ENABLED: "off",
    MCP_APPS_CARDS: opts.switch ?? "flags",
    FLAGS_URL: "https://flags.test",
    RELAY_ROOM: { idFromName: (name: string) => name, get: () => fakeRoom(opts.phone === undefined ? "17374202658" : opts.phone) },
  };
  const ctx = { id: { toString: () => "ab".repeat(32) }, waitUntil: () => undefined };
  const agent = new RelayMCP(ctx as any, env as any);
  (agent as any).props = { accountRef: "acct_test" };
  await agent.init();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await (agent as any).server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);
  const changed = { tools: 0, resources: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed.tools++; });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => { changed.resources++; });
  return { agent, client, changed };
}

describe("mcp-apps-cards.FLAG.2 off: exactly as before", () => {
  it("the flag row off: no _meta.ui, the usual outputSchema, no cards page, result-only structuredContent", async () => {
    flagsOn = false;
    const { client } = await session();
    expect(flagCalls[0]).toBe("https://flags.test/active?app=KAPTION&version=99.0.0&phone=17374202658");
    const tools = (await client.listTools()).tools;
    for (const name of CARD_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool._meta?.ui).toBeUndefined();
      expect(tool._meta?.["openai/outputTemplate"]).toBeUndefined();
      expect(Object.keys((tool.outputSchema as any).properties)).toEqual(["result"]);
    }
    expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain(CARDS_UI_URI);
    await expect(client.readResource({ uri: CARDS_UI_URI })).rejects.toThrow(/not found/);
    const q: any = await client.callTool({ name: "query", arguments: { query: "delivery" } });
    expect(q.structuredContent).toEqual({ result: A.search });
    const refused: any = await client.callTool({ name: "send_message", arguments: { conversation_id: "5511987654821@c.us", message: "refuse" } });
    expect(refused.structuredContent).toBeUndefined();
    // mcp-apps-cards.AVATAR.1 — no picture tool while off.
    expect(tools.map((t) => t.name)).not.toContain(AVATARS_TOOL);
  });

  it("the relay's switch unset or off: the flags worker is never asked", async () => {
    for (const sw of ["", "off"]) {
      const { client } = await session({ switch: sw });
      expect((await client.listTools()).tools.find((t) => t.name === "query")?._meta?.ui).toBeUndefined();
    }
    expect(flagCalls).toEqual([]);
  });

  it("no phone for the account, or the flags worker down: off", async () => {
    const none = await session({ phone: null });
    expect((await none.client.listTools()).tools.find((t) => t.name === "query")?._meta?.ui).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const down = await session();
    expect((await down.client.listTools()).tools.find((t) => t.name === "query")?._meta?.ui).toBeUndefined();
  });
});

describe("mcp-apps-cards.FLAG.3 on", () => {
  it("the card tools link the cards page and allow a card beside result", async () => {
    const { client } = await session();
    const tools = (await client.listTools()).tools;
    for (const name of CARD_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool._meta).toMatchObject({ ui: { resourceUri: CARDS_UI_URI }, "openai/outputTemplate": CARDS_UI_URI, securitySchemes: expect.any(Array) });
      expect(Object.keys((tool.outputSchema as any).properties)).toEqual(["result", "card"]);
    }
    expect(tools.find((t) => t.name === "list_contacts")?._meta?.ui).toBeUndefined();
    expect((await client.listResources()).resources.find((r) => r.uri === CARDS_UI_URI)).toMatchObject({ name: "cards.html", mimeType: "text/html;profile=mcp-app" });
    const read: any = await client.readResource({ uri: CARDS_UI_URI });
    expect(read.contents[0].text).toBe(CARDS_UI_HTML);
  });

  it("mcp-apps-cards.DATA.1-2 — the card beside result; the text answer is unchanged", async () => {
    const { client } = await session();
    const q: any = await client.callTool({ name: "query", arguments: { query: "delivery" } });
    expect(q.structuredContent.result).toEqual(A.search);
    expect(q.structuredContent.card).toMatchObject({ kind: "search", total: 5, chats: 4 });
    expect(JSON.parse(q.content[0].text)).toEqual(A.search);
    const sent: any = await client.callTool({ name: "send_message", arguments: { conversation_id: "5511987654821@c.us", message: "x" } });
    expect(sent.structuredContent.card).toMatchObject({ kind: "sent", status: "sent", whatsapp: "read" });
    const got: any = await client.callTool({ name: "get_scheduled_message", arguments: { id: "loc_10", mode: "local" } });
    expect(got.structuredContent.card).toMatchObject({ kind: "scheduled", single: true });
    const list: any = await client.callTool({ name: "list_scheduled_messages", arguments: {} });
    expect(list.structuredContent.card.items).toHaveLength(4);
  });

  it("mcp-apps-cards.SENT.3 — a refused send carries its not-sent card beside the same error text", async () => {
    const { client } = await session();
    const refused: any = await client.callTool({ name: "send_message", arguments: { conversation_id: "5511987654821@c.us", message: "refuse" } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe(A.refusal_text);
    expect(refused.structuredContent.card).toMatchObject({ kind: "sent", status: "not_sent", reason: "not-a-contact" });
  });

  it("mcp-apps-cards.FLAG.4 — a later change re-registers the card tools and announces the page", async () => {
    flagsOn = false;
    const { agent, client, changed } = await session();
    expect((await client.listTools()).tools.find((t) => t.name === "query")?._meta?.ui).toBeUndefined();
    flagsOn = true;
    clearCardsFlagCache();
    (agent as any).cardsCheckedAt = Date.now() - CARDS_FLAG_TTL_MS - 1;
    await agent.refreshManageVisibility();
    await new Promise((r) => setTimeout(r, 10));
    expect(changed.tools).toBeGreaterThan(0);
    expect(changed.resources).toBeGreaterThan(0);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "send_message")?._meta?.ui).toEqual({ resourceUri: CARDS_UI_URI });
    expect(tools.map((t) => t.name).filter((n) => n === "query")).toHaveLength(1);
    const q: any = await client.callTool({ name: "query", arguments: { query: "delivery" } });
    expect(q.structuredContent.card.kind).toBe("search");
  });
});

describe("mcp-apps-cards.AVATAR the card-only picture tool", () => {
  it("AVATAR.1 — listed while on, only to the card (visibility app, openai private, widget accessible)", async () => {
    const { client } = await session();
    const tool = (await client.listTools()).tools.find((t) => t.name === AVATARS_TOOL)!;
    expect(tool._meta).toMatchObject({ ui: { resourceUri: CARDS_UI_URI, visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true });
    const card = (await client.listTools()).tools.find((t) => t.name === "send_message")!;
    expect(card._meta?.["openai/widgetAccessible"]).toBe(true);
  });

  it("AVATAR.2-4 — forwarded to the extension; only data: pictures come back, the rest is null", async () => {
    const { client } = await session();
    const r: any = await client.callTool({ name: AVATARS_TOOL, arguments: { ids: ["5511987654821@c.us", "5511987654822@c.us", "5511987654823@c.us"] } });
    expect(roomCalls).toContain("get_avatars");
    expect(r.structuredContent).toEqual({ avatars: { "5511987654821@c.us": PIC, "5511987654822@c.us": null, "5511987654823@c.us": null } });
    expect(r.content[0].text).not.toContain("base64");
    expect(r.isError).toBeFalsy();
  });

  it("AVATAR.3 — an extension without get_avatars: no pictures, not an error", async () => {
    avatarsDown = true;
    const { client } = await session();
    const r: any = await client.callTool({ name: AVATARS_TOOL, arguments: { ids: ["5511987654821@c.us"] } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ avatars: { "5511987654821@c.us": null } });
  });

  it("AVATAR.1 — the flag turning off removes the tool", async () => {
    const { agent, client } = await session();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(AVATARS_TOOL);
    flagsOn = false;
    clearCardsFlagCache();
    (agent as any).cardsCheckedAt = Date.now() - CARDS_FLAG_TTL_MS - 1;
    await agent.refreshManageVisibility();
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(AVATARS_TOOL);
  });
});

describe("mcp-apps-cards.FLAG.1 the flags worker lookup", () => {
  it("reads the row like rest-api; caches 5 minutes per phone; keeps the last answer through an outage", async () => {
    expect(flagOn({ flags: [{ name: "MCP_APPS_CARDS", remoteEnabled: true, remoteDisabled: true }] }, "MCP_APPS_CARDS")).toBe(false);
    const env = { MCP_APPS_CARDS: "flags", FLAGS_URL: "https://flags.test/" };
    let answer: boolean | "down" = true;
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (answer === "down") throw new Error("down");
      return new Response(JSON.stringify({ flags: [{ name: "MCP_APPS_CARDS", remoteEnabled: answer }] }));
    }) as unknown as typeof fetch;
    expect(await cardsOnForPhone(env, "+1 (737) 420-2658", f, 0)).toBe(true);
    expect(calls).toEqual(["https://flags.test/active?app=KAPTION&version=99.0.0&phone=17374202658"]);
    answer = false;
    expect(await cardsOnForPhone(env, "17374202658", f, 1000)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await cardsOnForPhone(env, "17374202658", f, CARDS_FLAG_TTL_MS + 1)).toBe(false);
    answer = "down";
    expect(await cardsOnForPhone(env, "17374202658", f, 3 * CARDS_FLAG_TTL_MS)).toBe(false);
    expect(await cardsOnForPhone(env, "15555550100", f, 0)).toBe(false);
    expect(await cardsOnForPhone({ MCP_APPS_CARDS: "off" }, "17374202658", f, 0)).toBe(false);
  });
});

describe("mcp.LOCAL_HUB.4 target_session in the cloud", () => {
  it("is accepted by every tool but never sent to the extension", async () => {
    const { client } = await session();
    roomParams.length = 0;
    await client.callTool({ name: "list_groups", arguments: { target_session: "sess_x" } });
    await client.callTool({ name: "query", arguments: { query: "delivery", target_session: "sess_x" } });
    expect(roomParams.length).toBe(2);
    for (const p of roomParams) expect(p).not.toHaveProperty("target_session");
  });
});
