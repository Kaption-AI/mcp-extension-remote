/**
 * mcp-usage-ledger.CREDITS (Kaption-AI monorepo features/mcp/mcp-usage-ledger.feature.yaml), owner 2026-11-25 - the
 * ledger counts credits a month: each recorded call weighs its tool's credits (mcp-usage-pricing.CREDIT.1), a free or
 * lifetime month is judged from rest-api's since day, and a credits month is refused past its number.
 */
import { SignJWT } from "jose";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("agents/mcp", () => ({
  McpAgent: class McpAgent {
    static serveSSE() { return { fetch: async () => new Response("sse") }; }
    static serve() { return { fetch: async () => new Response("mcp") }; }
    props: unknown;
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));
vi.mock("./relay-room", () => ({ RelayRoom: class RelayRoom {} }));
vi.mock("./deployment-chain", () => ({ DeploymentChainDO: class DeploymentChainDO {} }));

import { RelayMCP } from "./relay-mcp";
import { createFetchHandler } from "./index";
import { deriveAccountRef } from "./otp";
import { brazilMobileVariant } from "./phone-alias";
import { countWindow, parsePlan, windowRange } from "./ledger-windows";
import { parseUseRequest } from "./ledger-read";
import { UsageLedger, type SqlLike } from "./usage-ledger";
import { hourOf } from "./usage";
import fixture from "./test-support/mcp-credit-classes.json";
import { creditClass, creditsOf } from "./credits";
import { refusalFallback } from "./weekly-usage";
import { isToolName, usageKind } from "./usage";

import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";

const PHONE = "17373427172";
const SECRET = "phone-ref-secret";
const REFUSAL = "Claude and ChatGPT actions: the 20 a week of this plan are used up. They come back on Monday; for more, choose a plan at https://kaptionai.com/pay/17373427172.";
const auth = { Authorization: "Bearer internal-api-key", "Content-Type": "application/json" };

function sqlite(): SqlLike {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const rows = /^\s*SELECT/i.test(query) ? (statement.all(...(bindings as never[])) as Record<string, unknown>[]) : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows };
    },
  };
}

function ledgers(envRef: { env: Env }) {
  const objects = new Map<string, UsageLedger>();
  const pending: Promise<unknown>[] = [];
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!objects.has(id)) {
        const state = {
          storage: { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => 1, setAlarm: async () => undefined },
          waitUntil: (p: Promise<unknown>) => void pending.push(p),
        };
        objects.set(id, new UsageLedger(state as never, envRef.env));
      }
      return objects.get(id)!;
    },
    settle: () => Promise.all(pending.splice(0)),
  };
}

const planAnswer = (over: Record<string, unknown> = {}) => ({
  tier: "free", period: "month", unit: "credits", limit: 100, pool: null, enforced_by: "ledger", enforce: true, message: REFUSAL, lang: "en", ttl_seconds: 60, ...over,
});

/** rest-api's /__internal/mcp-ledger/plan; anything else fails the test. */
function restApi(answer: (() => Response) | Record<string, unknown> = planAnswer()) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    asked.push(String(url));
    if (!String(url).endsWith("/__internal/mcp-ledger/plan")) throw new Error(`unexpected ${url}`);
    return typeof answer === "function" ? answer() : Response.json(answer);
  });
  return { fetcher, asked };
}

function fakeRoom(phone: string, fail = false, features: Record<string, boolean> = {}) {
  const room = {
    calls: [] as string[],
    async watchManage() { return { manage_kaption: true, plans: true, ...features }; },
    async meteringPhone() { return phone; },
    async handleMcpRequestSettled(method: string) {
      room.calls.push(method);
      if (fail) return { ok: false, error: { code: -32000, message: "extension offline" } };
      return { ok: true, result: { ok: true } };
    },
  };
  return room;
}

async function world(vars: Record<string, string> = {}, opts: { fail?: boolean; features?: Record<string, boolean> } = {}) {
  const room = fakeRoom(PHONE, opts.fail, opts.features);
  const envRef = { env: {} as Env };
  const ns = ledgers(envRef);
  envRef.env = {
    OAUTH_KV: new FakeKV(),
    USAGE_LEDGER_ENABLED: "on",
    USAGE_LEDGER: ns,
    RELAY_ROOM: { idFromName: (name: string) => name, get: () => room },
    INTERNAL_API_BASE_URL: "https://api.test",
    INTERNAL_API_KEY: "internal-api-key",
    JWT_SECRET: "jwt-secret",
    PHONE_REF_SECRET: SECRET,
    EPHEMERAL_STATE_SECRET: "ephemeral",
    ...vars,
  } as unknown as Env;
  const env = envRef.env;
  const accountRef = (await deriveAccountRef(PHONE, SECRET))!;
  const waits: Promise<unknown>[] = [];
  const agent = new RelayMCP({ id: { toString: () => "ab".repeat(32) } } as any, env as any);
  (agent as any).props = { accountRef };
  (agent as any).ctx = { id: { toString: () => "ab".repeat(32) }, waitUntil: (p: Promise<unknown>) => waits.push(p) };
  await agent.init();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await (agent as any).server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);
  const settle = async () => {
    await Promise.all(waits.splice(0));
    await ns.settle();
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as any;
    await settle();
    return res;
  };
  const handler = createFetchHandler({ fetch: async () => new Response("next") });
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const http = async (path: string, init?: RequestInit) => {
    const res = await handler(new Request(`https://mcp.kaptionai.com${path}`, init), env, ctx);
    await settle();
    return res;
  };
  const ledger = () => ns.get(`usage:${accountRef}`);
  const week = async () => (await ledger().windows()).week!;
  const month = async (since?: number | null) => (await ledger().windows({ since })).month!;
  return { room, env, tool, http, ledger, week, month };
}

const jwt = () => new SignJWT({ phone: PHONE }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("jwt-secret"));
const localBatch = (id: string, rows: Record<string, unknown>[]) => ({ batchId: id, rows: rows.map((r) => ({ hour: hourOf(Date.now()), client: "claude-desktop", tool: "query", outcome: "ok", latency: "<1s", calls: 1, ...r })) });
const postBatch = async (w: Awaited<ReturnType<typeof world>>, id: string, rows: Record<string, unknown>[]) =>
  w.http("/ext/usage/local", { method: "POST", headers: { Authorization: `Bearer ${await jwt()}`, "Content-Type": "application/json" }, body: JSON.stringify(localBatch(id, rows)) });
const reserveLocal = (w: Awaited<ReturnType<typeof world>>, body: Record<string, unknown>) =>
  w.http("/internal/ledger/use", { method: "POST", headers: auth, body: JSON.stringify({ phone: PHONE, change: "reserve", source: "local", limit: 100, enforce: true, period: "month", unit: "credits", ...body }) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mcp-usage-ledger.CREDITS the credit table", () => {
  it("mcp-usage-ledger.CREDITS.3 — replays the extension's credit classes (a transcribed read counts as a plain read here)", () => {
    expect(fixture.cases.length).toBeGreaterThan(200);
    for (const c of fixture.cases as { method: string; params: Record<string, unknown>; transcribed: number; result: string }[]) {
      if (!isToolName(c.method) || c.method === "initialize" || c.method === "ping") continue; // protocol methods (tools/list, ...) are never tool calls in the ledger
      const expected = c.result === "read_transcribed" ? "read" : c.transcribed > 0 && c.method === "call_recordings" && c.result === "export" ? null : c.result;
      if (expected === null) continue; // a call recording list that transcribed is the device's 5; the relay cannot see it
      expect([c.method, c.params, creditClass(c.method, usageKind(c.method, c.params))]).toEqual([c.method, c.params, expected]);
    }
  });

  it("mcp-usage-ledger.CREDITS.3 — routed reads are reads, sends 2, summaries 3, exports and recordings 5, settings 0", () => {
    expect(creditsOf("list_reminders", "")).toBe(1);
    expect(creditsOf("manage_reminders", "list")).toBe(1);
    expect(creditsOf("manage_reminders", "create")).toBe(2);
    expect(creditsOf("manage_status", "schedule")).toBe(2);
    expect(creditsOf("manage_labels", "add")).toBe(1);
    expect(creditsOf("send_message", "")).toBe(2);
    expect(creditsOf("summarize_conversation", "")).toBe(3);
    expect(creditsOf("export_chat", "html")).toBe(5);
    expect(creditsOf("call_recordings", "get")).toBe(5);
    expect(creditsOf("call_recordings", "list")).toBe(1);
    expect(creditsOf("get_analytics", "export_contacts")).toBe(5);
    expect(creditsOf("kaption_help", "")).toBe(0);
    expect(creditsOf("query", "messages")).toBe(1);
  });

  it("kaption-links.MCP.5 — create_tracked_links is a send (2 credits), list_tracked_links and get_link_clicks are reads (1)", () => {
    expect(creditClass("create_tracked_links", "")).toBe("send");
    expect(creditsOf("create_tracked_links", "")).toBe(2);
    expect(creditClass("list_tracked_links", "")).toBe("read");
    expect(creditsOf("list_tracked_links", "")).toBe(1);
    expect(creditClass("get_link_clicks", "")).toBe("read");
    expect(creditsOf("get_link_clicks", "")).toBe(1);
  });

  it("advanced-analytics.MCP.6 — each new get_analytics section costs one read credit", () => {
    for (const section of ["community_activity", "channel_posts", "post_detail", "community_changes", "message_reads"]) {
      const kind = usageKind("get_analytics", { section, chat_id: "120363000000000001@newsletter", post_id: "123" });
      expect([section, kind, creditClass("get_analytics", kind), creditsOf("get_analytics", kind)]).toEqual([section, section, "read", 1]);
    }
  });

  it("mcp-usage-ledger.CREDITS.1 — the plan answer's unit, since and the business_agent tier are read; an older answer stays in actions", () => {
    const p = parsePlan(planAnswer({ since: "2026-11-25T00:00:00.000Z" }))!;
    expect(p).toMatchObject({ tier: "free", period: "month", limit: 100, unit: "credits", enforce: true, since: Date.UTC(2026, 10, 25) });
    expect(parsePlan({ tier: "business_agent", period: "month", limit: 4000, unit: "credits", enforced_by: "none", enforce: false })).toMatchObject({ tier: "business_agent", enforce: false, unit: "credits" });
    // A Pro month without overage is counted, never enforced, even in credits.
    expect(parsePlan({ tier: "pro", period: "month", limit: 1000, unit: "credits", enforced_by: "device", enforce: false })?.enforce).toBe(false);
    expect(parsePlan({ tier: "free", period: "week", limit: 20, enforced_by: "ledger", enforce: true })).toMatchObject({ unit: "actions", since: null, enforce: true });
  });

  it("mcp-usage-ledger.CREDITS.6 — /internal/ledger/use reads unit, since and credits strictly", () => {
    const ok = parseUseRequest({ phone: PHONE, change: "reserve", source: "local", limit: 100, enforce: true, period: "month", unit: "credits", since: "2026-11-25T00:00:00Z", credits: 5, actionIds: ["mcp:abcdefgh"] });
    expect(ok).toMatchObject({ use: { unit: "credits", since: Date.UTC(2026, 10, 25), credits: 5, period: "month" } });
    expect(parseUseRequest({ phone: PHONE, unit: "credits", credits: 101 })).toEqual({ error: "credits must be 0-100." });
    expect(parseUseRequest({ phone: PHONE, unit: "coins" })).toEqual({ error: "unit must be credits or actions." });
    expect(parseUseRequest({ phone: PHONE, since: "nope" })).toEqual({ error: "since must be an ISO date-time." });
    // Without a unit the request is exactly what it was.
    expect((parseUseRequest({ phone: PHONE, limit: 20, enforce: true }) as any).use.unit).toBeUndefined();
  });
});

describe("mcp-usage-ledger.CREDITS a credits month", () => {
  it("mcp-usage-pricing.CREDITS_V2.2, mcp-usage-ledger.CREDITS.4-5 — a free account's month is 100 credits across roads; the call that would pass it is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 11, 10, 12) });
    vi.stubGlobal("fetch", restApi(planAnswer()).fetcher);
    const w = await world();
    // Cloud: 10 reads (10), 5 sends (10), 2 summaries (6), 4 exports (20) = 46 credits.
    for (let i = 0; i < 10; i++) expect((await w.tool("query", { entity: "messages" })).isError).toBeFalsy();
    for (let i = 0; i < 5; i++) expect((await w.tool("manage_reminders", { action: "create", title: "x", datetime: "2026-12-20T10:00:00Z" })).isError).toBeFalsy();
    for (let i = 0; i < 2; i++) expect((await w.tool("summarize_conversation", { conversation_id: "x" })).isError).toBeFalsy();
    for (let i = 0; i < 4; i++) expect((await w.tool("export_contacts", {})).isError).toBeFalsy();
    expect(await w.month()).toMatchObject({ counted: 21, credits: 46, pending: 0 });
    // Local: a 5-credit reservation counts 5 while it waits for its record ...
    const r = await reserveLocal(w, { actionIds: ["mcp:local-call-0001"], credits: 5 });
    expect(await r.json()).toMatchObject({ ok: true, counted: 1, used: 51, limit: 100, left: 49 });
    // ... and its batch row (export_contacts) replaces it with the same 5.
    expect((await postBatch(w, "batch_local_c1", [{ tool: "export_contacts" }])).status).toBe(200);
    expect(await w.month()).toMatchObject({ counted: 22, credits: 51, pending: 0 });
    // A reservation without credits counts 1 until its record.
    expect(await (await reserveLocal(w, { actionIds: ["mcp:local-call-0002"] })).json()).toMatchObject({ ok: true, used: 52 });
    expect((await postBatch(w, "batch_local_c2", [{ tool: "query" }])).status).toBe(200);
    // A free tool in a batch (settings, help) is never counted.
    expect((await postBatch(w, "batch_local_c4", [{ tool: "get_kaption_settings", calls: 3 }])).status).toBe(200);
    expect((await w.month()).credits).toBe(52);
    // 48 more reads reach exactly 100.
    expect((await postBatch(w, "batch_local_c3", [{ tool: "query", calls: 47 }])).status).toBe(200);
    expect((await w.tool("query", { entity: "messages" })).isError).toBeFalsy();
    expect((await w.month()).credits).toBe(100);
    // The 101st credit: refused with rest-api's words, nothing counted.
    const before = w.room.calls.length;
    const res = await w.tool("query", { entity: "messages" });
    expect(res.isError).toBe(true);
    expect(w.room.calls.length).toBe(before);
    expect(await (await reserveLocal(w, { actionIds: ["mcp:local-call-x001"] })).json()).toMatchObject({ ok: false, counted: 0, used: 100, left: 0 });
    // The read API answers the same credits.
    const read = await w.http(`/internal/ledger/usage?phone=${PHONE}`, { headers: auth });
    expect(((await read.json()) as any).month).toMatchObject({ credits: 100 });
  });

  it("mcp-usage-ledger.CREDITS.2, mcp-usage-pricing.CREDITS_V2.8 — the month is judged from the since day: credits spent before it never count", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 24, 12) });
    let since: string | undefined;
    vi.stubGlobal("fetch", restApi(() => Response.json(planAnswer({ ...(since ? { since } : {}), ttl_seconds: 1 }))).fetcher);
    const w = await world();
    // The day before the switch: 60 actions under the old count (here with no since: all counted).
    expect((await postBatch(w, "batch_before_01", [{ tool: "export_contacts", calls: 20 }])).status).toBe(200);
    expect((await w.month()).credits).toBe(100);
    // The switch day: rest-api now says since 2026-11-25.
    since = "2026-11-25T00:00:00.000Z";
    vi.setSystemTime(Date.UTC(2026, 10, 25, 9));
    expect((await w.month(Date.UTC(2026, 10, 25))).credits).toBe(0);
    // A call runs (its plan is refreshed first), the whole November before the 25th left out.
    await w.ledger().planFor(PHONE, Date.now() + 5_000);
    expect((await w.tool("query", { entity: "messages" })).isError).toBeFalsy();
    const local = await reserveLocal(w, { actionIds: ["mcp:local-after-01"], since, credits: 2 });
    expect(await local.json()).toMatchObject({ ok: true, used: 3, limit: 100, left: 97 });
    // Without since the read is the whole month.
    expect((await w.month()).credits).toBe(103);
    const read = await w.http(`/internal/ledger/usage?phone=${PHONE}&since=${encodeURIComponent(since)}`, { headers: auth });
    expect(((await read.json()) as any).month).toMatchObject({ credits: 3, from: "2026-11-25T00:00:00.000Z" });
  });

  it("kaption-links.MCP.5 — relayed Kaption Links calls weigh 2 (create) and 1 (list, clicks) in the month, cloud and local alike", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 11, 10, 12) });
    vi.stubGlobal("fetch", restApi(planAnswer({ tier: "business", limit: 2000, enforced_by: "none", enforce: false })).fetcher);
    const w = await world({}, { features: { kaption_links: true } });
    // Cloud: 2 creates (4), 1 list (1), 1 clicks read (1) = 6 credits.
    for (let i = 0; i < 2; i++) expect((await w.tool("create_tracked_links", { links: [{ url: "https://example.com/sale" }] })).isError).toBeFalsy();
    expect((await w.tool("list_tracked_links", { q: "sale" })).isError).toBeFalsy();
    expect((await w.tool("get_link_clicks", {})).isError).toBeFalsy();
    expect(w.room.calls).toEqual(["create_tracked_links", "create_tracked_links", "list_tracked_links", "get_link_clicks"]);
    expect(await w.month()).toMatchObject({ counted: 4, credits: 6 });
    // Local hub batch rows weigh the same.
    expect((await postBatch(w, "batch_links_01", [{ tool: "create_tracked_links", calls: 3 }, { tool: "get_link_clicks" }])).status).toBe(200);
    expect(await w.month()).toMatchObject({ counted: 8, credits: 13 });
  });

  it("mcp-usage-pricing.CREDITS_V2.4, mcp-usage-ledger.SINGLE.10 — a Pro month in credits is counted and shown, never refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 11, 3, 12) });
    vi.stubGlobal("fetch", restApi(planAnswer({ tier: "pro", limit: 2, enforced_by: "none", enforce: false })).fetcher);
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await w.tool("export_contacts", {})).isError).toBeFalsy();
    expect(await w.month()).toMatchObject({ counted: 3, credits: 15 });
  });

  it("mcp-usage-ledger.CREDITS.8 — the relay's fallback refusal says credits this month", () => {
    expect(refusalFallback(100, "month", "credits")).toBe(
      "This Kaption account has used this month's 100 Claude and ChatGPT credits. Tell the user they come back on the 1st, or to choose a plan at https://kaptionai.com/pricing for more.",
    );
    expect(refusalFallback(20)).toContain("this week's 20 Claude and ChatGPT actions");
  });

  it("mcp-usage-ledger.CREDITS.4 — the window answers credits: pending reservations with their own credits", () => {
    const range = windowRange("month", "2026-12")!;
    const out = countWindow(range, [
      { path: "cloud", tool: "send_message", kind: "", outcome: "ok", calls: 2 },
      { path: "local", tool: "manage_reminders", kind: "list", outcome: "ok", calls: 3 },
      { path: "local", tool: "kaption_help", kind: "", outcome: "ok", calls: 9 },
      { path: "cloud", tool: "query", kind: "", outcome: "error", calls: 4 },
    ], { local: 2 }, false, 7);
    expect(out).toMatchObject({ counted: 7, credits: 2 * 2 + 3 + 7, pending: 2 });
  });
});
