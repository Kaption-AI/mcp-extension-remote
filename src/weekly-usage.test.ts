/**
 * weekly-plan-limits.SERVER.13, COUNT.10, LIMITS.14 and mcp-usage-pricing.USAGE.1-8 (Kaption-AI monorepo specs) — the
 * cloud relay counts a listed phone's calls on rest-api's weekly ledger and tells the user what is left; with both
 * switches unset nothing is asked and every result is exactly as before.
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
import { normalizeUsage, usageHeaders, usageLang, usageLine, usageMeta, withUsageHeaders, type Usage } from "./weekly-usage";
import fixture from "./test-support/weekly-plan-limits-usage.json";
import { FakeKV } from "./test-support/fake-kv";

const OWNER = "17373427172";
const WEEK: Usage = { period: "week", used: 17, limit: 20, left: 3, resetsAt: "2026-11-16T00:00:00.000Z", source: "ledger", overage: null };
const REFUSAL = "Claude and ChatGPT actions: the 20 a week of this plan are used up. They come back on Monday; for more, choose a plan at https://kaptionai.com/pay/17373427172.";

/** rest-api's /__internal/mcp-ledger/use and /access: `left` calls left before the limit. */
function restApi(opts: { left?: number; usage?: Usage | null; lang?: string; status?: number } = {}) {
  let left = opts.left ?? 10;
  const posts: { path: string; body: any }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.test/__internal/mcp-ledger/", "");
    const body = JSON.parse(String(init?.body));
    posts.push({ path, body });
    expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("key");
    if (opts.status) return new Response("{}", { status: opts.status });
    const extra = body.usage && opts.usage !== null ? { usage: opts.usage ?? WEEK, lang: opts.lang ?? "en" } : {};
    if (path === "access") return Response.json({ blocked: false, ttl_seconds: 600, ...extra });
    if (body.change === "refund") { left++; return Response.json({ allowed: true, counted: true, refunded: true, ...extra }); }
    if (left <= 0) return Response.json({ allowed: false, code: "weekly-limit-reached", message: REFUSAL, ...extra }, { status: 402 });
    left--;
    return Response.json({ allowed: true, counted: true, duplicate: false, ...extra });
  });
  return { fetcher, posts };
}

function fakeRoom(phone: string, fail = false) {
  const room = {
    calls: [] as string[],
    async watchManage() { return { manage_kaption: true, plans: true }; },
    async meteringPhone() { return phone; },
    async handleMcpRequestSettled(method: string) {
      room.calls.push(method);
      if (fail) return { ok: false, error: { code: -32000, message: "extension offline" } };
      return { ok: true, result: { ok: true } };
    },
  };
  return room;
}

async function session(vars: Record<string, string>, fail = false) {
  const room = fakeRoom(OWNER, fail);
  const waits: Promise<unknown>[] = [];
  const env = {
    OAUTH_KV: new FakeKV(),
    USAGE_LEDGER_ENABLED: "off",
    RELAY_ROOM: { idFromName: (name: string) => name, get: () => room },
    INTERNAL_API_BASE_URL: "https://api.test",
    INTERNAL_API_KEY: "key",
    ...vars,
  };
  const agent = new RelayMCP({ id: { toString: () => "ab".repeat(32) }, waitUntil: (p: Promise<unknown>) => waits.push(p) } as any, env as any);
  (agent as any).props = { accountRef: "acct_test" };
  (agent as any).ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
  await agent.init();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await (agent as any).server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);
  return { client, room, waits };
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;

afterEach(() => vi.unstubAllGlobals());

describe("weekly-plan-limits.SERVER.13 the relay counts cloud calls on the weekly ledger", () => {
  it("weekly-plan-limits.SERVER.13, COUNT.10 a listed phone's call is reserved with its own action id before it runs", async () => {
    const rest = restApi({ left: 5 });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session({ WEEKLY_PLAN_LIMITS_PHONES: OWNER });
    const res = await call(client, "query", { action: "chats" });
    expect(res.isError).toBeFalsy();
    expect(room.calls.length).toBe(1);
    expect(rest.posts).toEqual([{ path: "use", body: { phone: OWNER, change: "reserve", actionId: expect.stringMatching(/^[0-9a-f-]{36}$/) } }]);
    // No usage asked for (MCP_USAGE_IN_RESULTS unset): the result is the same as before.
    expect(res._meta).toBeUndefined();
    expect(res.content).toHaveLength(1);
  });

  it("weekly-plan-limits.SERVER.13 at the limit the call is refused with rest-api's words and never reaches the extension", async () => {
    const rest = restApi({ left: 0 });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session({ WEEKLY_PLAN_LIMITS_PHONES: "*" });
    const res = await call(client, "query", { action: "chats" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Error: ${REFUSAL}`);
    expect(room.calls).toEqual([]);
  });

  it("weekly-plan-limits.LIMITS.14 a failed call gives its slot back (same action id)", async () => {
    const rest = restApi({ left: 5 });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, waits } = await session({ WEEKLY_PLAN_LIMITS_PHONES: OWNER }, true);
    const res = await call(client, "query", { action: "chats" });
    expect(res.isError).toBe(true);
    await Promise.all(waits);
    const [reserve, refund] = rest.posts;
    expect(refund).toEqual({ path: "use", body: { phone: OWNER, change: "refund", actionId: reserve.body.actionId } });
  });

  it("mcp-usage-pricing.PRICE.1 settings, help and plans tools are never counted", async () => {
    const rest = restApi({ left: 0 });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client } = await session({ WEEKLY_PLAN_LIMITS_PHONES: OWNER });
    await call(client, "kaption_plans", {});
    await call(client, "get_api_info", {});
    expect(rest.fetcher).not.toHaveBeenCalled();
  });

  it("disabled-gating.MCP.5 rest-api down: the call runs", async () => {
    const rest = restApi({ status: 503 });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session({ WEEKLY_PLAN_LIMITS_PHONES: OWNER });
    expect((await call(client, "query", { action: "chats" })).isError).toBeFalsy();
    expect(room.calls.length).toBe(1);
  });

  it("mcp-usage-pricing.USAGE.8 both switches unset (or another phone): nothing is asked, the result is byte-for-byte the same", async () => {
    const rest = restApi();
    vi.stubGlobal("fetch", rest.fetcher);
    const before = await call((await session({})).client, "query", { action: "chats" });
    const other = await call((await session({ WEEKLY_PLAN_LIMITS_PHONES: "15555550101", MCP_USAGE_IN_RESULTS: "off" })).client, "query", { action: "chats" });
    expect(rest.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(other)).toBe(JSON.stringify(before));
  });
});

describe("lifetime-local.HOLDER.7 every Lifetime account is counted by the week (rest-api's /access says weekly)", () => {
  /** rest-api for a Lifetime holder outside the relay's WEEKLY_PLAN_LIMITS_PHONES: /access says weekly, /use counts 20 a week. */
  function lifetimeApi(left: number) {
    const posts: { path: string; body: any }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.test/__internal/mcp-ledger/", "");
      const body = JSON.parse(String(init?.body));
      posts.push({ path, body });
      if (path === "access") {
        return Response.json(left > 0
          ? { blocked: false, weekly: true, remaining: left, limit: 20, ttl_seconds: 60 }
          : { blocked: true, code: "weekly-limit-reached", message: REFUSAL, resets_at: "2026-11-16T00:00:00.000Z", ttl_seconds: 60 });
      }
      if (body.change === "refund") { left++; return Response.json({ allowed: true, counted: true, refunded: true }); }
      if (left <= 0) return Response.json({ allowed: false, code: "weekly-limit-reached", message: REFUSAL }, { status: 402 });
      left--;
      return Response.json({ allowed: true, counted: true, duplicate: false });
    });
    return { fetcher, posts };
  }

  it("lifetime-local.HOLDER.7 a Lifetime phone not in WEEKLY_PLAN_LIMITS_PHONES: 20 calls are reserved, the 21st is refused", async () => {
    const rest = lifetimeApi(20);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, room } = await session({ DISABLED_FULL_GATING_PHONES: "*", WEEKLY_PLAN_LIMITS_PHONES: "15555550101" });
    for (let i = 0; i < 20; i++) expect((await call(client, "query", { action: "chats" })).isError).toBeFalsy();
    expect(rest.posts.filter((p) => p.path === "use" && p.body.change === "reserve")).toHaveLength(20);
    const res = await call(client, "query", { action: "chats" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Error: ${REFUSAL}`);
    expect(room.calls).toHaveLength(20);
  });

  it("lifetime-local.HOLDER.7 a failed Lifetime call gives its slot back", async () => {
    const rest = lifetimeApi(5);
    vi.stubGlobal("fetch", rest.fetcher);
    const { client, waits } = await session({ DISABLED_FULL_GATING_PHONES: "*" }, true);
    expect((await call(client, "query", { action: "chats" })).isError).toBe(true);
    await Promise.all(waits);
    const uses = rest.posts.filter((p) => p.path === "use");
    expect(uses.map((p) => p.body.change)).toEqual(["reserve", "refund"]);
    expect(uses[1].body.actionId).toBe(uses[0].body.actionId);
  });

  it("lifetime-local.HOLDER.7 an account /access does not call weekly (Pro, Business, Free outside the switch) is never counted", async () => {
    const rest = restApi();
    vi.stubGlobal("fetch", rest.fetcher);
    const { client } = await session({ DISABLED_FULL_GATING_PHONES: "*" });
    expect((await call(client, "query", { action: "chats" })).isError).toBeFalsy();
    expect(rest.posts.map((p) => p.path)).toEqual(["access"]);
  });
});

describe("mcp-usage-pricing.USAGE.5-7 what is left, in every tool result", () => {
  it("mcp-usage-pricing.USAGE.6 _meta.kaption.usage on the result, from the ledger answer; the line only near the limit", async () => {
    const rest = restApi({ left: 5 });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client } = await session({ WEEKLY_PLAN_LIMITS_PHONES: OWNER, MCP_USAGE_IN_RESULTS: "on" });
    const res = await call(client, "query", { action: "chats" });
    expect(rest.posts[0].body).toMatchObject({ change: "reserve", usage: true });
    expect(res._meta).toEqual({ kaption: { usage: WEEK } });
    expect(res.content.at(-1).text).toBe("Kaption: 3 of 20 Claude and ChatGPT actions left this week (resets Monday).");
  });

  it("mcp-usage-pricing.USAGE.5 a usage-only phone (not counted weekly) asks /access, and no line while plenty is left", async () => {
    const plenty: Usage = { period: "month", used: 40, limit: 250, left: 210, resetsAt: "2026-12-01T00:00:00.000Z", source: "ledger", overage: null };
    const rest = restApi({ usage: plenty });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client } = await session({ MCP_USAGE_IN_RESULTS: OWNER });
    const res = await call(client, "query", { action: "chats" });
    expect(rest.posts).toEqual([{ path: "access", body: { phone: OWNER, usage: true } }]);
    expect(res._meta.kaption.usage).toEqual(plenty);
    expect(res.content).toHaveLength(1);
  });

  it("mcp-usage-pricing.USAGE.4, USAGE.7 the line is in the account's language", async () => {
    const rest = restApi({ left: 5, lang: "pt" });
    vi.stubGlobal("fetch", rest.fetcher);
    const { client } = await session({ WEEKLY_PLAN_LIMITS_PHONES: OWNER, MCP_USAGE_IN_RESULTS: "*" });
    const res = await call(client, "query", { action: "chats" });
    expect(res.content.at(-1).text).toBe("Kaption: restam 3 de 20 ações do Claude e ChatGPT nesta semana (renova na segunda-feira).");
  });
});

describe("mcp-usage-pricing.USAGE.1, USAGE.6-7 the pure rules", () => {
  it("mcp-usage-pricing.USAGE_IN_RESULTS.1-3 replays the shared fixture's usage section (normalizeUsage, usageMeta, usageLang, usageLine)", () => {
    expect(fixture.usage.length).toBeGreaterThan(100);
    for (const c of fixture.usage as any[]) {
      expect(normalizeUsage(c.value)).toEqual(c.normalized);
      expect(usageMeta(c.value)).toEqual(c.meta);
      expect(usageLang(c.lang)).toBe(c.langUsed);
      expect(usageLine(c.value, c.lang)).toBe(c.result);
    }
  });

  it("mcp-usage-pricing.USAGE.6 headers, a header omitted when its value is null", () => {
    expect(usageHeaders(WEEK)).toEqual({
      "X-Kaption-Usage-Period": "week", "X-Kaption-Usage-Used": "17", "X-Kaption-Usage-Limit": "20", "X-Kaption-Usage-Left": "3",
      "X-Kaption-Usage-Resets": "2026-11-16T00:00:00.000Z",
    });
    expect(usageHeaders({ ...WEEK, limit: null, left: null, overage: { enabled: true, spent: 35, cap: 1000, balance: 900 } })).toEqual({
      "X-Kaption-Usage-Period": "week", "X-Kaption-Usage-Used": "17", "X-Kaption-Usage-Resets": "2026-11-16T00:00:00.000Z",
      "X-Kaption-Overage-Spent": "35", "X-Kaption-Overage-Cap": "1000", "X-Kaption-Overage-Balance": "900",
    });
  });

  it("mcp-usage-pricing.USAGE.6, USAGE.8 the response headers on a JSON /mcp result; untouched when off, SSE or without usage", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const rpc = { jsonrpc: "2.0", id: 1, result: { content: [], _meta: { kaption: { usage: WEEK } } } };
    const on = await withUsageHeaders(json(rpc), { MCP_USAGE_IN_RESULTS: "on" });
    expect(on.headers.get("X-Kaption-Usage-Left")).toBe("3");
    expect(await on.json()).toEqual(rpc);
    const off = json(rpc);
    expect(await withUsageHeaders(off, {})).toBe(off);
    const sse = new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    expect(await withUsageHeaders(sse, { MCP_USAGE_IN_RESULTS: "on" })).toBe(sse);
    expect((await withUsageHeaders(json({ result: {} }), { MCP_USAGE_IN_RESULTS: "on" })).headers.get("X-Kaption-Usage-Left")).toBeNull();
  });
});
