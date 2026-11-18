/**
 * mcp-overage-billing (Kaption-AI monorepo features/mcp/mcp-overage-billing.feature.yaml) — postpaid Claude and ChatGPT
 * overage on the ledger: past the plan's number an opted-in account keeps going within its monthly cap, every extra
 * action is recorded once, failed ones are never billed, and rest-api reads and claims each cycle once.
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
import { parsePlan } from "./ledger-windows";
import { parseUseRequest, readCycle } from "./ledger-read";
import { OverageStore, overageCycle, parseOverage } from "./overage";
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


const CAP_WORDS = "You reached the US$0.05 you allowed for extra Claude and ChatGPT actions this month.";
/** Lifetime 2 a week (small numbers keep the test short), 1.25¢ an extra action, US$0.05 cap = 4 extra actions. */
const OVERAGE = { price_millicents: 1250, cap_millicents: 5000, anchor_ms: Date.UTC(2026, 0, 1), message: CAP_WORDS };
const lifetimePlan = (over: Record<string, unknown> = {}) => planAnswer({ tier: "lifetime", limit: 2, overage: OVERAGE, ...over });
const cycleNow = () => overageCycle(OVERAGE.anchor_ms, Date.now());
const readOverage = async (w: Awaited<ReturnType<typeof world>>) => {
  const c = cycleNow();
  return (await (await w.http(`/internal/ledger/overage?phone=${PHONE}&from=${c.from}&to=${c.to}`, { headers: auth })).json()) as any;
};
const bill = (w: Awaited<ReturnType<typeof world>>, body: Record<string, unknown>) => {
  const c = cycleNow();
  return w.http("/internal/ledger/overage/bill", { method: "POST", headers: auth, body: JSON.stringify({ phone: PHONE, from: c.from, to: c.to, ...body }) });
};

afterEach(() => vi.unstubAllGlobals());

describe("mcp-overage-billing.CYCLE monthly cycles from one anchor", () => {
  it("mcp-overage-billing.CYCLE.2 — the 1st 00:00 UTC anchor gives calendar months", () => {
    const a = Date.UTC(2026, 0, 1);
    expect(overageCycle(a, Date.UTC(2026, 10, 18, 9))).toEqual({ from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1) });
    expect(overageCycle(a, Date.UTC(2026, 11, 31, 23, 59))).toEqual({ from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) });
    expect(overageCycle(a, Date.UTC(2026, 11, 1))).toEqual({ from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) });
  });

  it("mcp-overage-billing.CYCLE.1, CYCLE.3 — a subscription anchor (day and time) repeats monthly, clamped to short months", () => {
    const a = Date.UTC(2025, 0, 31, 14, 30, 5);
    expect(overageCycle(a, Date.UTC(2026, 1, 10))).toEqual({ from: Date.UTC(2026, 0, 31, 14, 30, 5), to: Date.UTC(2026, 1, 28, 14, 30, 5) });
    expect(overageCycle(a, Date.UTC(2026, 2, 1))).toEqual({ from: Date.UTC(2026, 1, 28, 14, 30, 5), to: Date.UTC(2026, 2, 31, 14, 30, 5) });
    expect(overageCycle(a, Date.UTC(2026, 2, 31, 14, 30, 4))).toMatchObject({ from: Date.UTC(2026, 1, 28, 14, 30, 5) });
  });

  it("mcp-overage-billing.CYCLE.4 — the shared fixture replays the same as rest-api", async () => {
    const fixture = (await import("./test-support/mcp-overage-cycles.json")).default as { anchor: string; at: string; from: string; to: string }[];
    for (const c of fixture) {
      const got = overageCycle(Date.parse(c.anchor), Date.parse(c.at));
      expect({ from: new Date(got.from).toISOString(), to: new Date(got.to).toISOString() }).toEqual({ from: c.from, to: c.to });
    }
  });
});

describe("mcp-overage-billing.LEDGER extra actions on the ledger", () => {
  it("mcp-overage-billing.LEDGER.1-3 — past the weekly number an opted-in account keeps going until the cap, then the cap's words", async () => {
    vi.stubGlobal("fetch", restApi(lifetimePlan()).fetcher);
    const w = await world();
    for (let i = 0; i < 6; i++) expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    const res = await w.tool("query", { action: "chats" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Error: ${CAP_WORDS}`);
    expect(await readOverage(w)).toMatchObject({ calls: 4, amount_mc: 5000, pending: 0, cap_mc: 5000, carried_mc: 0, bill: null });
    expect(await w.week()).toMatchObject({ counted: 6 });
  });

  it("mcp-overage-billing.LEDGER.6 — without overage in the plan the 3rd action is refused with the plan's words, nothing recorded", async () => {
    vi.stubGlobal("fetch", restApi(planAnswer({ tier: "lifetime", limit: 2 })).fetcher);
    const w = await world();
    for (let i = 0; i < 2; i++) expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    expect((await w.tool("query", { action: "chats" })).content[0].text).toBe(`Error: ${REFUSAL}`);
    expect(await readOverage(w)).toMatchObject({ calls: 0, amount_mc: 0 });
  });

  it("mcp-overage-billing.LEDGER.4 — a failed extra action is given back and never billed", async () => {
    vi.stubGlobal("fetch", restApi(lifetimePlan({ limit: 0 })).fetcher);
    const w = await world({}, { fail: true });
    expect((await w.tool("query", { action: "chats" })).isError).toBe(true);
    expect(await readOverage(w)).toMatchObject({ calls: 0, amount_mc: 0, pending: 0 });
  });

  it("mcp-overage-billing.LEDGER.1-2 — a month plan (Pro) with overage is held to its month, extra actions recorded", async () => {
    vi.stubGlobal("fetch", restApi(planAnswer({ tier: "pro", period: "month", limit: 1, enforced_by: "device", enforce: true, overage: { ...OVERAGE, price_millicents: 1000 } })).fetcher);
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    expect(await readOverage(w)).toMatchObject({ calls: 2, amount_mc: 2000 });
  });

  it("mcp-overage-billing.LEDGER.2, LEDGER.4-5 — device calls: past the number recorded as extra, a repeated id once, a refund given back, the batch makes them billable", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world();
    const overage = OVERAGE;
    const ids = ["mcp:dev-call-0001", "mcp:dev-call-0002", "mcp:dev-call-0003", "mcp:dev-call-0004"];
    const r = await reserveLocal(w, { actionIds: ids, limit: 2, overage });
    expect(await r.json()).toMatchObject({ ok: true, counted: 4, overage: 2 });
    expect(await (await reserveLocal(w, { actionIds: ids.slice(3), limit: 2, overage })).json()).toMatchObject({ counted: 0, duplicates: 1 });
    expect(await readOverage(w)).toMatchObject({ calls: 0, pending: 2, pending_mc: 2500 });
    await reserveLocal(w, { change: "refund", actionIds: ids.slice(3) });
    expect((await postBatch(w, "batch_overage_1", [{ calls: 3 }])).status).toBe(200);
    expect(await readOverage(w)).toMatchObject({ calls: 1, amount_mc: 1250, pending: 0 });
    // Past the cap: all or nothing, the reason says why.
    const big = await reserveLocal(w, { count: 5, limit: 2, overage });
    expect(big.status).toBe(402);
    expect(await big.json()).toMatchObject({ ok: false, counted: 0, reason: "cap" });
  });
});

describe("mcp-overage-billing.LEDGER.7-8 rest-api's read and claim", () => {
  it("mcp-overage-billing.LEDGER.8, BILL.5 — a cycle is claimed once; a carried amount reaches the next cycle", async () => {
    vi.stubGlobal("fetch", restApi(lifetimePlan()).fetcher);
    const w = await world();
    expect((await bill(w, { state: "claim" })).status).toBe(200);
    expect((await bill(w, { state: "claim" })).status).toBe(409);
    expect(await (await bill(w, { state: "carried", amount_mc: 3000, calls: 2 })).json()).toMatchObject({ ok: true, bill: { state: "carried", amount_mc: 3000 } });
    expect((await bill(w, { state: "claim" })).status).toBe(409);
    const c = cycleNow();
    const next = await (await w.http(`/internal/ledger/overage?phone=${PHONE}&from=${c.to}&to=${overageCycle(OVERAGE.anchor_ms, c.to).to}`, { headers: auth })).json() as any;
    expect(next).toMatchObject({ carried_mc: 3000, bill: null });
  });

  it("mcp-overage-billing.LEDGER.7 — only rest-api's key; bad cycles are 400", async () => {
    vi.stubGlobal("fetch", restApi().fetcher);
    const w = await world();
    expect((await w.http(`/internal/ledger/overage?phone=${PHONE}&from=1&to=2`)).status).toBe(401);
    expect((await w.http(`/internal/ledger/overage?phone=${PHONE}&from=5&to=2`, { headers: auth })).status).toBe(400);
    expect((await bill(w, { state: "paid" })).status).toBe(400);
    expect(readCycle(0, 40 * 86_400_000)).toBeNull();
  });
});

describe("mcp-overage-billing pure rules", () => {
  it("mcp-overage-billing.LEDGER.1 — the plan's overage is read defensively; a month plan is enforced only with it", () => {
    expect(parseOverage({ price_millicents: 0, cap_millicents: 1, anchor_ms: 0 })).toBeNull();
    expect(parseOverage(OVERAGE)).toMatchObject({ priceMc: 1250, capMc: 5000 });
    expect(parsePlan({ tier: "pro", period: "month", limit: 250, enforce: true })).toMatchObject({ enforce: false, overage: null });
    expect(parsePlan({ tier: "pro", period: "month", limit: 250, enforce: true, overage: OVERAGE })).toMatchObject({ enforce: true });
    expect(parseUseRequest({ phone: PHONE, period: "year" })).toHaveProperty("error");
    expect(parseUseRequest({ phone: PHONE, overage: { price_millicents: 1 } })).toHaveProperty("error");
  });

  it("mcp-overage-billing.LEDGER.8-9 — a stale claim can be taken again; finish needs a claim; rows are pruned after 400 days", () => {
    const db = new DatabaseSync(":memory:");
    const sql: SqlLike = { exec(q: string, ...b: unknown[]) { const s = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? (s.all(...(b as never[])) as Record<string, unknown>[]) : (s.run(...(b as never[])), []); return { toArray: () => rows }; } };
    const store = new OverageStore(sql);
    const range = { from: 0, to: 1000 };
    expect(store.finish(0, "billed", {}, 1)).toBeNull();
    expect(store.claim(range, 10).ok).toBe(true);
    expect(store.claim(range, 20).ok).toBe(false);
    expect(store.claim(range, 10 + 30 * 60_000).ok).toBe(true);
    expect(store.finish(0, "failed", {}, 50)?.state).toBe("failed");
    expect(store.claim(range, 60).ok).toBe(true);
    const o = parseOverage(OVERAGE)!;
    store.add(["cloud:x1"], o, 100);
    store.prune(100 + 401 * 86_400_000);
    expect(store.spentMc({ from: 0, to: Number.MAX_SAFE_INTEGER })).toBe(0);
  });
});
