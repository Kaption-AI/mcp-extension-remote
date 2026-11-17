/**
 * mcp-usage-ledger.SINGLE (Kaption-AI monorepo features/mcp/mcp-usage-ledger.feature.yaml) — one counter: every
 * Claude/ChatGPT action of every account is counted in its UsageLedger, and an account rest-api holds to a weekly number
 * is refused there. A cloud call (the relay), a local-bridge call (rest-api's /internal/ledger/use reservation plus the
 * device batch) and a Kally data read (the device batch) all land in the same count.
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
  tier: "free", period: "week", limit: 20, pool: null, enforced_by: "ledger", enforce: true, message: REFUSAL, lang: "en", ttl_seconds: 60, ...over,
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

async function world(vars: Record<string, string> = {}, opts: { fail?: boolean } = {}) {
  const room = fakeRoom(PHONE, opts.fail);
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
  return { room, env, tool, http, ledger, week };
}

const jwt = () => new SignJWT({ phone: PHONE }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("jwt-secret"));
const localBatch = (id: string, rows: Record<string, unknown>[]) => ({ batchId: id, rows: rows.map((r) => ({ hour: hourOf(Date.now()), client: "claude-desktop", tool: "query", outcome: "ok", latency: "<1s", calls: 1, ...r })) });
const postBatch = async (w: Awaited<ReturnType<typeof world>>, id: string, rows: Record<string, unknown>[]) =>
  w.http("/ext/usage/local", { method: "POST", headers: { Authorization: `Bearer ${await jwt()}`, "Content-Type": "application/json" }, body: JSON.stringify(localBatch(id, rows)) });
const reserveLocal = (w: Awaited<ReturnType<typeof world>>, body: Record<string, unknown>) =>
  w.http("/internal/ledger/use", { method: "POST", headers: auth, body: JSON.stringify({ phone: PHONE, change: "reserve", source: "local", limit: 20, enforce: true, ...body }) });

afterEach(() => vi.unstubAllGlobals());

describe("mcp-usage-ledger.SINGLE one counter for every road", () => {
  it("mcp-usage-ledger.SINGLE.1, SINGLE.2 — a cloud call, a local-bridge call and a Kally read all add to the same count", async () => {
    const rest = restApi();
    vi.stubGlobal("fetch", rest.fetcher);
    const w = await world();
    // Cloud: reserved and recorded by the relay.
    expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    expect(await w.week()).toMatchObject({ counted: 1, by_source: { cloud: 1, local: 0, webmcp: 0 }, pending: 0 });
    // Local bridge: rest-api reserves it before it runs (pending until the device batch lands) ...
    const r = await reserveLocal(w, { actionIds: ["mcp:local-call-0001"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, counted: 1, used: 2, limit: 20, left: 18 });
    expect(await w.week()).toMatchObject({ counted: 2, by_source: { cloud: 1, local: 1 }, pending: 1 });
    // ... and its batch records it: still counted once.
    expect((await postBatch(w, "batch_local_01", [{}])).status).toBe(200);
    expect(await w.week()).toMatchObject({ counted: 2, by_source: { cloud: 1, local: 1 }, pending: 0 });
    // Kally's data read arrives in the batch with source kally: one more on the same count.
    expect((await postBatch(w, "batch_kally_01", [{ source: "kally", client: "", tool: "query" }])).status).toBe(200);
    expect(await w.week()).toMatchObject({ counted: 3, by_source: { cloud: 1, local: 2, webmcp: 0 }, kally: 1 });
    // And rest-api's read API answers the same number.
    const read = await w.http(`/internal/ledger/usage?phone=${PHONE}`, { headers: auth });
    expect(((await read.json()) as any).week).toMatchObject({ counted: 3, kally: 1 });
  });

  it("mcp-usage-ledger.SINGLE.4, weekly-plan-limits.SERVER.17 — the 21st action of a free-past-60 account's week is refused with rest-api's words, whatever road used the first 20", async () => {
    const rest = restApi();
    vi.stubGlobal("fetch", rest.fetcher);
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    expect((await reserveLocal(w, { actionIds: Array.from({ length: 5 }, (_, i) => `mcp:local-call-${i}000`) })).status).toBe(200);
    expect((await postBatch(w, "batch_kally_02", [{ source: "kally", client: "", calls: 5 }])).status).toBe(200);
    expect((await w.week()).counted).toBe(20);
    // Cloud 21st: refused, never reaches the extension, recorded as refused.
    const before = w.room.calls.length;
    const res = await w.tool("query", { action: "chats" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Error: ${REFUSAL}`);
    expect(w.room.calls.length).toBe(before);
    // Local 21st: 402 with "0 left", nothing counted.
    const local = await reserveLocal(w, { actionIds: ["mcp:local-call-x001"] });
    expect(local.status).toBe(402);
    expect(await local.json()).toMatchObject({ ok: false, counted: 0, used: 20, limit: 20, left: 0 });
    expect(await w.week()).toMatchObject({ counted: 20, refused: 1 });
    // A refused account's plans, help and settings tools still answer (never counted).
    expect((await w.tool("kaption_plans", {})).isError).toBeFalsy();
  });

  it("weekly-plan-limits.LIMITS.14, mcp-usage-ledger.SINGLE.4 — a failed cloud call gives its reservation back", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world({}, { fail: true });
    expect((await w.tool("query", { action: "chats" })).isError).toBe(true);
    expect(await w.week()).toMatchObject({ counted: 0, pending: 0, total: 1 });
  });

  it("mcp-usage-ledger.SINGLE.10 — Pro is counted and never refused (no reservation, no wait)", async () => {
    vi.stubGlobal("fetch", restApi(planAnswer({ tier: "pro", period: "month", limit: 2, enforced_by: "none", enforce: false })).fetcher);
    const w = await world();
    for (let i = 0; i < 4; i++) expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    expect(await w.week()).toMatchObject({ counted: 4, pending: 0 });
  });

  it("mcp-usage-ledger.SINGLE.1, SINGLE.15 — counted with WEEKLY_PLAN_LIMITS_PHONES unset (or naming someone else)", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world({ WEEKLY_PLAN_LIMITS_PHONES: "15550000000" });
    await w.tool("query", { action: "chats" });
    expect((await w.week()).counted).toBe(1);
    expect((await w.ledger().windows()).plan).toMatchObject({ enforce: true, limit: 20 });
  });

  it("mcp-usage-ledger.SINGLE.5, PLAN.5 — no plan cached and rest-api down: the call runs and is counted", async () => {
    vi.stubGlobal("fetch", restApi(() => new Response("{}", { status: 503 })).fetcher);
    const w = await world();
    expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    expect((await w.week()).counted).toBe(1);
  });

  it("mcp-usage-pricing.PRICE.1 — settings, help and plans tools are never reserved and never ask for the plan", async () => {
    const rest = restApi();
    vi.stubGlobal("fetch", rest.fetcher);
    const w = await world();
    await w.tool("kaption_plans", {});
    await w.tool("get_api_info", {});
    expect(rest.asked).toEqual([]);
    expect((await w.week()).counted).toBe(0);
  });

  it("mcp-usage-ledger.PLAN.4, SINGLE.3 — the plan is asked once while fresh (60 s for an enforced account)", async () => {
    const rest = restApi();
    vi.stubGlobal("fetch", rest.fetcher);
    const w = await world();
    await w.tool("query", { action: "chats" });
    await w.tool("query", { action: "chats" });
    expect(rest.asked).toHaveLength(1);
  });

  it("mcp-usage-pricing.USAGE.6-7 — what is left comes from the ledger's own week, in the account's language", async () => {
    vi.stubGlobal("fetch", restApi(planAnswer({ lang: "pt" })).fetcher);
    const w = await world({ MCP_USAGE_IN_RESULTS: PHONE });
    for (let i = 0; i < 16; i++) await w.tool("query", { action: "chats" });
    const res = await w.tool("query", { action: "chats" });
    expect(res._meta.kaption.usage).toMatchObject({ period: "week", used: 17, limit: 20, left: 3, source: "ledger", overage: null });
    expect(res.content.at(-1).text).toBe("Kaption: restam 3 de 20 ações do Claude e ChatGPT nesta semana (renova na segunda-feira).");
  });
});

describe("mcp-usage-ledger.SINGLE.6 POST /internal/ledger/use", () => {
  it("mcp-usage-ledger.SINGLE.6, IDEMPOTENCY.1-2 — a repeated id is counted once; a refund gives back only live ids", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world();
    const one = await (await reserveLocal(w, { actionIds: ["mcp:aaaaaaaa1", "mcp:aaaaaaaa2"] })).json();
    expect(one).toMatchObject({ counted: 2, duplicates: 0, used: 2 });
    const again = await (await reserveLocal(w, { actionIds: ["mcp:aaaaaaaa2", "mcp:aaaaaaaa3"] })).json();
    expect(again).toMatchObject({ counted: 1, duplicates: 1, used: 3 });
    const back = await (await reserveLocal(w, { change: "refund", actionIds: ["mcp:aaaaaaaa1", "mcp:never-seen"] })).json();
    expect(back).toMatchObject({ refunded: 1, used: 2 });
    // webmcp ids are their own road.
    expect(await (await reserveLocal(w, { source: "webmcp", actionIds: ["mcp:aaaaaaaa2"] })).json()).toMatchObject({ counted: 1, used: 3 });
    expect((await w.week()).by_source).toEqual({ cloud: 0, local: 2, webmcp: 1 });
  });

  it("mcp-usage-ledger.SINGLE.6 — a count without ids, all or nothing past the limit; not enforced: counted past it", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world();
    expect((await reserveLocal(w, { count: 19, limit: 20 })).status).toBe(200);
    expect((await reserveLocal(w, { count: 2, limit: 20 })).status).toBe(402);
    expect((await w.week()).counted).toBe(19);
    expect((await reserveLocal(w, { count: 2, limit: 20, enforce: false })).status).toBe(200);
    expect(await (await reserveLocal(w, { change: "refund", count: 1 })).json()).toMatchObject({ refunded: 1, used: 20 });
  });

  it("mcp-usage-ledger.SINGLE.6, READ.2 — only rest-api's key; bad bodies are 400", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world();
    expect((await w.http("/internal/ledger/use", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await reserveLocal(w, { source: "cloud" })).status).toBe(400);
    expect((await reserveLocal(w, { actionIds: ["x"] })).status).toBe(400);
    expect(parseUseRequest({ phone: PHONE, count: 1001 })).toHaveProperty("error");
    expect(parseUseRequest({ phone: PHONE, limit: -1 })).toHaveProperty("error");
    expect(parseUseRequest({ phone: PHONE, actionIds: ["mcp:abcdefgh"] })).toMatchObject({ use: { path: "local", actionIds: ["local:mcp:abcdefgh"], limit: null, enforce: false } });
  });
});

describe("mcp-usage-ledger.SINGLE.14 a Brazilian line's two written forms are one count", () => {
  it("mcp-usage-ledger.SINGLE.14 — 20 actions in the other form's ledger refuse the 21st in this one", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world();
    const BR = "5511987654321";
    const own = (await deriveAccountRef(BR, SECRET))!;
    const other = (await deriveAccountRef(brazilMobileVariant(BR)!, SECRET))!;
    const ns = w.env.USAGE_LEDGER as any;
    await ns.get(`usage:${other}`).use({ change: "reserve", path: "local", count: 20, limit: null, enforce: false });
    const begin = await ns.get(`usage:${own}`).cloudBegin({ phone: BR, actionId: "cloud:br-0001", tool: "query", accountRef: own });
    expect(begin).toMatchObject({ state: "refused", use: { used: 20, limit: 20, left: 0 } });
    const alone = await ns.get(`usage:${own}`).cloudBegin({ phone: BR, actionId: "cloud:br-0002", tool: "query" });
    expect(alone.state).toBe("run");
  });
});

describe("mcp-usage-ledger.SINGLE pure rules", () => {
  it("mcp-usage-ledger.SINGLE.2 — counted = recorded answered calls + pending reservations; Kally inside local", () => {
    const range = windowRange("week", "2026-11-16")!;
    const w = countWindow(range, [
      { path: "cloud", tool: "query", outcome: "ok", calls: 3 },
      { path: "local", tool: "query", outcome: "ok", calls: 2 },
      { path: "local", tool: "query", outcome: "ok", calls: 4, kally: true },
      { path: "local", tool: "kaption_help", outcome: "ok", calls: 9, kally: true },
    ], { local: 1, webmcp: 2 });
    expect(w).toMatchObject({ counted: 12, by_source: { cloud: 3, local: 7, webmcp: 2 }, kally: 4, pending: 3 });
  });

  it("mcp-usage-ledger.SINGLE.3 — enforce from rest-api (or an older rest-api's week_ledger); only a weekly number", () => {
    expect(parsePlan(planAnswer())).toMatchObject({ enforce: true, message: REFUSAL, lang: "en", ttlSeconds: 60 });
    expect(parsePlan(planAnswer({ enforce: undefined, enforced_by: "week_ledger" }))!.enforce).toBe(true);
    expect(parsePlan(planAnswer({ enforce: undefined, enforced_by: "none" }))!.enforce).toBe(false);
    expect(parsePlan(planAnswer({ tier: "pro", period: "month", limit: 250, enforce: true }))!.enforce).toBe(false);
    expect(parsePlan(planAnswer({ lang: "fr", message: 7 }))).toMatchObject({ lang: null, message: null });
  });
});
