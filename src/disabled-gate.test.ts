/**
 * disabled-gating.MCP.1-5, SWITCH.4 — a blocked (DISABLED) Kaption account gets no Claude or ChatGPT actions through
 * the cloud relay; the plans, checkout and help tools keep answering; unlisted phones are never asked about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("agents/mcp", () => ({
  McpAgent: class McpAgent {
    props: unknown;
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));
vi.mock("./otp", () => ({
  validateJwt: vi.fn(async () => "17373427172"),
  deriveAccountRef: vi.fn(async () => "acct_test"),
  validateExtensionSession: vi.fn(async () => null),
  sanitizeAccountRefForLog: (ref: string) => ref,
  normalizeAndValidatePhone: (p: string) => p,
}));

import { RelayMCP } from "./relay-mcp";
import { DISABLED_ALLOWED_TOOLS, DisabledGate, fetchAccess, gatedPhone } from "./disabled-gate";
import { FakeKV } from "./test-support/fake-kv";

const OWNER = "17373427172";
const PRO = "17370000002";
const MESSAGE = "This Kaption account is disabled, so Claude and ChatGPT actions are not available. Tell the user to choose a plan at https://kaptionai.com/pricing (or in Kaption on WhatsApp Web, Your Plan) to use them again.";

/** rest-api's POST /__internal/mcp-ledger/access, blocked for the listed phones. */
function restApi(blocked: string[], status = 200) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.test/__internal/mcp-ledger/access");
    expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("key");
    const phone = JSON.parse(String(init?.body)).phone;
    asked.push(phone);
    if (status !== 200) return new Response("{}", { status });
    return Response.json(blocked.includes(phone)
      ? { blocked: true, code: "account_disabled", message: MESSAGE, plans_url: "https://kaptionai.com/pricing", ttl_seconds: 600 }
      : { blocked: false, ttl_seconds: 600 });
  });
  return { fetcher, asked };
}

function fakeRoom(phone: string) {
  const room = {
    calls: [] as string[],
    async watchManage() { return { manage_kaption: true, plans: true }; },
    async meteringPhone() { return phone; },
    async handleMcpRequestSettled(method: string) {
      room.calls.push(method);
      if (method === "kaption_plans") return { ok: true, result: { plans: [], message: "Here are the plans." } };
      return { ok: true, result: { ok: true } };
    },
  };
  return room;
}

async function session(phone: string, phones: string | undefined) {
  const room = fakeRoom(phone);
  const env = {
    OAUTH_KV: new FakeKV(),
    USAGE_LEDGER_ENABLED: "off",
    RELAY_ROOM: { idFromName: (name: string) => name, get: () => room },
    INTERNAL_API_BASE_URL: "https://api.test",
    INTERNAL_API_KEY: "key",
    ...(phones === undefined ? {} : { DISABLED_FULL_GATING_PHONES: phones }),
  };
  const agent = new RelayMCP({ id: { toString: () => "ab".repeat(32) }, waitUntil: () => undefined } as any, env as any);
  (agent as any).props = { accountRef: "acct_test" };
  await agent.init();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await (agent as any).server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);
  return { client, room };
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;

afterEach(() => vi.unstubAllGlobals());

describe("disabled-gating on the cloud relay", () => {
  it("disabled-gating.MCP.1 a blocked account's tool call is refused with the plans link, before it reaches the extension", async () => {
    const rest = restApi([OWNER]);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session(OWNER, OWNER);
    const res = await call(client, "query", { action: "chats" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Error: ${MESSAGE}`);
    expect(res.content[0].text).toContain("https://kaptionai.com/pricing");
    expect(room.calls).toEqual([]);
    // The answer is kept for its ttl: a second call is refused without asking again.
    await call(client, "send_message", { to: "x", text: "y" });
    expect(rest.asked).toEqual([OWNER]);
  });

  it("disabled-gating.MCP.2 the plans tool keeps answering for a blocked account", async () => {
    const rest = restApi([OWNER]);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session(OWNER, OWNER);
    const res = await call(client, "kaption_plans", {});
    expect(res.isError).toBeFalsy();
    expect(room.calls).toEqual(["kaption_plans"]);
    expect([...DISABLED_ALLOWED_TOOLS]).toEqual(["kaption_plans", "create_kaption_checkout_link", "kaption_help", "report_bug", "get_api_info"]);
  });

  it("disabled-gating.CHECK.2 a Pro (or Lifetime) account in the list keeps working", async () => {
    const rest = restApi([]);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session(PRO, "*");
    const res = await call(client, "query", { action: "chats" });
    expect(res.isError).toBeFalsy();
    expect(room.calls.length).toBe(1);
    expect(rest.asked).toEqual([PRO]);
  });

  it("disabled-gating.SWITCH.4 unset list: nothing is asked and every call runs as before", async () => {
    const rest = restApi([OWNER]);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session(OWNER, undefined);
    const res = await call(client, "query", { action: "chats" });
    expect(res.isError).toBeFalsy();
    expect(room.calls.length).toBe(1);
    expect(rest.fetcher).not.toHaveBeenCalled();
  });

  it("disabled-gating.SWITCH.4 a phone outside the list is never asked about", async () => {
    const rest = restApi([PRO]);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session(PRO, OWNER);
    expect((await call(client, "query", { action: "chats" })).isError).toBeFalsy();
    expect(room.calls.length).toBe(1);
    expect(rest.fetcher).not.toHaveBeenCalled();
  });

  it("disabled-gating.MCP.5 rest-api down: the call runs and the next call asks again", async () => {
    const rest = restApi([OWNER], 503);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session(OWNER, OWNER);
    expect((await call(client, "query", { action: "chats" })).isError).toBeFalsy();
    expect((await call(client, "query", { action: "chats" })).isError).toBeFalsy();
    expect(room.calls.length).toBe(2);
    expect(rest.asked).toEqual([OWNER, OWNER]);
  });
});

describe("disabled-gating relay helpers", () => {
  it("disabled-gating.SWITCH.4 the list: digits match with or without +, * is everyone, empty nobody", () => {
    expect(gatedPhone(OWNER, {})).toBe(false);
    expect(gatedPhone(OWNER, { DISABLED_FULL_GATING_PHONES: "" })).toBe(false);
    expect(gatedPhone(`+${OWNER}`, { DISABLED_FULL_GATING_PHONES: OWNER })).toBe(true);
    expect(gatedPhone(PRO, { DISABLED_FULL_GATING_PHONES: OWNER })).toBe(false);
    expect(gatedPhone(PRO, { DISABLED_FULL_GATING_PHONES: "*" })).toBe(true);
  });

  it("disabled-gating.MCP.3 an unparseable answer counts as no answer", async () => {
    const env = { INTERNAL_API_BASE_URL: "https://api.test", INTERNAL_API_KEY: "key" };
    expect(await fetchAccess(env, OWNER, (async () => Response.json({ nope: 1 })) as any)).toBeNull();
    expect(await fetchAccess(env, OWNER, (async () => { throw new Error("down"); }) as any)).toBeNull();
    expect(await fetchAccess({ INTERNAL_API_BASE_URL: "", INTERNAL_API_KEY: "" }, OWNER)).toBeNull();
  });

  it("disabled-gating.MCP.5 a refused room lookup lets the call run", async () => {
    const gate = new DisabledGate({ env: { INTERNAL_API_BASE_URL: "https://api.test", INTERNAL_API_KEY: "key", DISABLED_FULL_GATING_PHONES: "*" }, phone: async () => { throw new Error("rpc"); } });
    expect(await gate.refusal("query")).toBeNull();
  });
});
