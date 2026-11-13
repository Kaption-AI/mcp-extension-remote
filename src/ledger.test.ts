/**
 * The unified ledger, phase 1 (kaptionai features/mcp/mcp-usage-ledger.feature.yaml): windows, plan cache, shadow,
 * the internal read API and the split global totals.
 */
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchHandler } from "./index";
import { deriveAccountRef } from "./otp";
import { brazilMobileVariant } from "./phone-alias";
import { countWindow, parsePlan, planFresh, shadowOf, shadowPhone, weekOf, weekRange, weekStart, windowRange } from "./ledger-windows";
import { mergeLedgerWindows } from "./ledger-read";
import { UsageLedger, UsageTotals, totalsNames, totalsShardName, type LedgerWindows, type SqlLike } from "./usage-ledger";
import { FakeKV } from "./test-support/fake-kv";
import type { UsageCell } from "./usage";
import type { Env } from "./types";

vi.mock("./relay-mcp", () => ({
  RelayMCP: { serveSSE: () => ({ fetch: async () => new Response("sse") }), serve: () => ({ fetch: async () => new Response("mcp") }) },
}));
vi.mock("./relay-room", () => ({ RelayRoom: class RelayRoom {} }));
vi.mock("./deployment-chain", () => ({ DeploymentChainDO: class DeploymentChainDO {} }));

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

function doState() {
  const pending: Promise<unknown>[] = [];
  const state = {
    storage: { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => 1, setAlarm: async () => undefined },
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  };
  return { state, settle: () => Promise.all(pending.splice(0)) };
}

function namespace<T>(make: (state: ReturnType<typeof doState>["state"]) => T) {
  const objects = new Map<string, { object: T; settle: () => Promise<unknown> }>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!objects.has(id)) {
        const { state, settle } = doState();
        objects.set(id, { object: make(state), settle });
      }
      return objects.get(id)!.object;
    },
    names: () => [...objects.keys()],
    settle: () => Promise.all([...objects.values()].map((o) => o.settle())),
  };
}

const cell = (over: Partial<UsageCell> = {}): UsageCell => ({
  hour: Date.UTC(2026, 10, 10, 14),
  path: "cloud",
  connection: "grant-a",
  app: "ChatGPT",
  tool: "query",
  kind: "",
  outcome: "ok",
  latency: "<1s",
  calls: 1,
  repeats: 0,
  ...over,
});

const PHONE = "17373427172";
const BR_PHONE = "5511987654321";
const NOW = Date.UTC(2026, 10, 10, 15, 0); // Tuesday 10 Nov 2026
const planAnswer = (over: Record<string, unknown> = {}) => ({ tier: "free", period: "week", limit: 20, pool: null, enforced_by: "week_ledger", ttl_seconds: 600, ...over });

function relayEnv(extra: Partial<Env> = {}) {
  const totals = namespace((state) => new UsageTotals(state as never, {} as Env));
  const env = {
    OAUTH_KV: new FakeKV(),
    JWT_SECRET: "jwt-secret",
    PHONE_REF_SECRET: "phone-ref-secret",
    INTERNAL_API_KEY: "internal-api-key",
    INTERNAL_API_BASE_URL: "https://api.test",
    EPHEMERAL_STATE_SECRET: "ephemeral",
    USAGE_TOTALS: totals,
    ...extra,
  } as unknown as Env;
  const ledgers = namespace((state) => new UsageLedger(state as never, env));
  (env as { USAGE_LEDGER: unknown }).USAGE_LEDGER = ledgers;
  const handler = createFetchHandler({ fetch: async () => new Response("next") });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`https://mcp.kaptionai.com${path}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    await ledgers.settle();
    await totals.settle();
    return response;
  };
  return { env, ledgers, totals, call };
}

const ledgerOf = async (r: ReturnType<typeof relayEnv>, phone = PHONE) =>
  r.ledgers.get(`usage:${(await deriveAccountRef(phone, "phone-ref-secret"))!}`) as unknown as UsageLedger;
const auth = { Authorization: "Bearer internal-api-key" };

describe("windows (mcp-usage-ledger.MODEL.2-4)", () => {
  it("mcp-usage-ledger.MODEL.3 — the week starts Monday 00:00 UTC", () => {
    expect(weekOf(NOW)).toBe("2026-11-09");
    expect(weekOf(Date.UTC(2026, 10, 9, 0, 0))).toBe("2026-11-09");
    expect(weekOf(Date.UTC(2026, 10, 8, 23, 59))).toBe("2026-11-02");
    expect(weekOf(Date.UTC(2026, 10, 15, 23, 59))).toBe("2026-11-09");
    expect(weekStart(Date.UTC(2027, 0, 1))).toBe(Date.UTC(2026, 11, 28));
    expect(weekRange("2026-11-10")).toBeNull();
    expect(weekRange("2026-11-09")).toEqual({ from: Date.UTC(2026, 10, 9), to: Date.UTC(2026, 10, 16) });
    expect(windowRange("month", "2026-13")).toBeNull();
  });

  it("mcp-usage-ledger.MODEL.2 — counts ok calls of counted tools on every road", () => {
    const range = windowRange("week", "2026-11-09")!;
    const w = countWindow(range, [
      { path: "cloud", tool: "query", outcome: "ok", calls: 5 },
      { path: "local", tool: "send_message", outcome: "ok", calls: 3 },
      { path: "webmcp", tool: "query", outcome: "ok", calls: 1 },
      { path: "cloud", tool: "query", outcome: "error", calls: 2 },
      { path: "cloud", tool: "query", outcome: "refused", calls: 4 },
      { path: "cloud", tool: "kaption_help", outcome: "ok", calls: 7 },
    ]);
    expect(w).toMatchObject({ period: "2026-11-09", counted: 9, by_source: { cloud: 5, local: 3, webmcp: 1 }, refused: 4, total: 22 });
  });

  it("mcp-usage-ledger.MODEL.4 — the ledger answers its week and month from the daily cells", async () => {
    const r = relayEnv();
    const ledger = await ledgerOf(r);
    await ledger.record([
      cell({ hour: Date.UTC(2026, 10, 9, 1), calls: 4 }), // this week
      cell({ hour: Date.UTC(2026, 10, 8, 23), calls: 6 }), // last week, this month
      cell({ hour: Date.UTC(2026, 9, 31, 12), calls: 9 }), // last month, last week
      cell({ hour: Date.UTC(2026, 10, 10, 9), path: "local", connection: "local-claude-desktop", calls: 2 }),
    ]);
    const w = await ledger.windows({}, NOW);
    expect(w.week).toMatchObject({ period: "2026-11-09", counted: 6, by_source: { cloud: 4, local: 2, webmcp: 0 } });
    expect(w.month).toMatchObject({ period: "2026-11", counted: 12 });
    const old = await ledger.windows({ week: "2026-10-26", month: "2026-10" }, NOW);
    expect(old.week!.counted).toBe(9);
    expect(old.month!.counted).toBe(9);
  });
});

describe("plan cache and shadow (mcp-usage-ledger.PLAN, SHADOW)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("mcp-usage-ledger.PLAN.1 — reads rest-api's answer defensively", () => {
    expect(parsePlan(planAnswer())).toMatchObject({ tier: "free", period: "week", limit: 20, enforcedBy: "week_ledger" });
    expect(parsePlan(planAnswer({ tier: "business", period: "month", limit: 750, pool: { ref: "pool_abcdef12", numbers: 3 } }))!.pool).toEqual({ ref: "pool_abcdef12", numbers: 3 });
    expect(parsePlan(planAnswer({ tier: "unlimited", period: null, limit: null }))).toMatchObject({ limit: null });
    expect(parsePlan(planAnswer({ tier: "nope" }))).toBeNull();
    expect(parsePlan(planAnswer({ period: null }))).toBeNull(); // a limit needs a window
    expect(parsePlan(planAnswer({ pool: { ref: "+17373427172", numbers: 2 } }))!.pool).toBeNull(); // never a phone
  });

  it("mcp-usage-ledger.PLAN.4 — fresh until its ttl and never past the window", () => {
    expect(planFresh(NOW, 600, NOW + 599_000, "week")).toBe(true);
    expect(planFresh(NOW, 600, NOW + 600_000, "week")).toBe(false);
    const sundayNight = Date.UTC(2026, 10, 15, 23, 55);
    expect(planFresh(sundayNight, 600, sundayNight + 6 * 60_000, "week")).toBe(false);
  });

  it("mcp-usage-ledger.SHADOW.1, SHADOW.3, PLAN.4 — notes when the window passes the limit; fetches the plan once per ttl", async () => {
    const r = relayEnv();
    const ledger = await ledgerOf(r);
    const fetchPlan = vi.fn(async () => new Response(JSON.stringify(planAnswer({ limit: 3 })), { status: 200 }));
    await ledger.record([cell({ calls: 3 })]);
    expect(await ledger.shadowAfter(PHONE, NOW, fetchPlan as never)).toEqual({ limit: 3, over: 0, crossed_at: null });
    await ledger.record([cell({ calls: 2 })]);
    expect(await ledger.shadowAfter(PHONE, NOW + 1000, fetchPlan as never)).toEqual({ limit: 3, over: 2, crossed_at: NOW + 1000 });
    await ledger.record([cell({ calls: 1 })]);
    expect(await ledger.shadowAfter(PHONE, NOW + 2000, fetchPlan as never)).toEqual({ limit: 3, over: 3, crossed_at: NOW + 1000 });
    expect(fetchPlan).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchPlan.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ phone: PHONE });
    const w = await ledger.windows({}, NOW + 3000);
    expect(w.plan).toMatchObject({ tier: "free", limit: 3, fetchedAt: NOW });
    expect(w.crossed.week).toBe(NOW + 1000);
  });

  it("mcp-usage-ledger.PLAN.5, SHADOW.2 — rest-api down: nothing is judged and nothing throws", async () => {
    const r = relayEnv();
    const ledger = await ledgerOf(r);
    await ledger.record([cell({ calls: 50 })]);
    expect(await ledger.shadowAfter(PHONE, NOW, (async () => { throw new Error("down"); }) as never)).toBeNull();
    expect(await ledger.shadowAfter(PHONE, NOW, (async () => new Response("{}", { status: 503 })) as never)).toBeNull();
    expect((await ledger.windows({}, NOW)).plan).toBeNull();
  });

  it("mcp-usage-ledger.SHADOW.1 — the switch lists phones, '*' is everyone, empty or off is nobody", () => {
    expect(shadowPhone(PHONE, { LEDGER_SHADOW: "" })).toBe(false);
    expect(shadowPhone(PHONE, { LEDGER_SHADOW: "off" })).toBe(false);
    expect(shadowPhone(PHONE, {})).toBe(false);
    expect(shadowPhone(PHONE, { LEDGER_SHADOW: "+1 737 342 7172" })).toBe(true);
    expect(shadowPhone("17374202658", { LEDGER_SHADOW: "17373427172" })).toBe(false);
    expect(shadowPhone("17374202658", { LEDGER_SHADOW: "*" })).toBe(true);
  });

  it("mcp-usage-ledger.SHADOW.3 — an unlimited plan never has anything over", () => {
    expect(shadowOf(null, 9999, 1)).toEqual({ limit: null, over: 0, crossed_at: null });
  });

  it("mcp-usage-ledger.SHADOW.1-2 — a local batch triggers the shadow only for listed phones, in the background", async () => {
    const plan = vi.fn(async () => new Response(JSON.stringify(planAnswer()), { status: 200 }));
    vi.stubGlobal("fetch", plan);
    const jwt = (phone: string) => new SignJWT({ phone }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("jwt-secret"));
    const batch = (id: string) => ({ batchId: id, rows: [{ hour: Date.UTC(2026, 10, 10, 14), client: "claude-ai", tool: "query", outcome: "ok", latency: "<1s", calls: 2 }] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const off = relayEnv({ LEDGER_SHADOW: "" });
      const post = (r: ReturnType<typeof relayEnv>, id: string, phone = PHONE) =>
        jwt(phone).then((t) => r.call("/ext/usage/local", { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(batch(id)) }));
      expect((await post(off, "batch_000001")).status).toBe(200);
      expect(plan).not.toHaveBeenCalled();

      const on = relayEnv({ LEDGER_SHADOW: PHONE });
      expect((await post(on, "batch_000002", "17374202658")).status).toBe(200);
      expect(plan).not.toHaveBeenCalled();
      expect((await post(on, "batch_000003")).status).toBe(200);
      expect(plan).toHaveBeenCalledTimes(1);
      expect((await (await ledgerOf(on)).windows({}, NOW)).plan).toMatchObject({ tier: "free", limit: 20 });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("internal read API (mcp-usage-ledger.READ.2-4)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it("mcp-usage-ledger.READ.2 — only the internal key reads, and bad input reads nothing", async () => {
    const r = relayEnv();
    expect((await r.call(`/internal/ledger/usage?phone=${PHONE}`)).status).toBe(401);
    expect((await r.call(`/internal/ledger/usage?phone=${PHONE}`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await r.call(`/internal/ledger/usage?phone=${PHONE}`, { headers: { "X-API-Key": "internal-api-key" } })).status).toBe(401);
    expect((await r.call(`/internal/ledger/usage?phone=12`, { headers: auth })).status).toBe(400);
    expect((await r.call(`/internal/ledger/usage?phone=${PHONE}&week=2026-11-10`, { headers: auth })).status).toBe(400);
    expect((await r.call(`/internal/ledger/usage/batch`, { method: "POST", headers: auth, body: JSON.stringify({ phones: [] }) })).status).toBe(400);
    expect(
      (await r.call(`/internal/ledger/usage/batch`, { method: "POST", headers: auth, body: JSON.stringify({ phones: Array(201).fill(PHONE) }) })).status,
    ).toBe(400);
    expect(r.ledgers.names()).toEqual([]);
  });

  it("mcp-usage-ledger.READ.3-4 — counts only, zeros for an unknown phone, never a connection id", async () => {
    const r = relayEnv();
    await (await ledgerOf(r)).record([cell({ calls: 4, connection: "grant-secret-id" }), cell({ calls: 1, outcome: "refused" })]);
    const res = await r.call(`/internal/ledger/usage?phone=${PHONE}`, { headers: auth });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("grant-secret-id");
    expect(text).not.toContain(PHONE);
    expect(JSON.parse(text)).toMatchObject({
      week: { period: "2026-11-09", counted: 4, by_source: { cloud: 4 }, refused: 1, total: 5 },
      month: { period: "2026-11", counted: 4 },
      since: "2026-11-10",
      plan: null,
      shadow: { week: null, month: null },
    });
    const unknown = await (await r.call(`/internal/ledger/usage?phone=17370000000`, { headers: auth })).json();
    expect(unknown).toMatchObject({ week: { counted: 0 }, month: { counted: 0 }, since: null });
  });

  it("mcp-usage-ledger.READ.8 — the month breakdown for rest-api: internal key only, uncounted tools out, counted = the window's", async () => {
    const r = relayEnv();
    expect((await r.call(`/internal/ledger/report?phone=${PHONE}`)).status).toBe(401);
    expect((await r.call(`/internal/ledger/report?phone=12`, { headers: auth })).status).toBe(400);
    expect((await r.call(`/internal/ledger/report?phone=${PHONE}&month=2026-13`, { headers: auth })).status).toBe(400);
    await (await ledgerOf(r)).record([
      cell({ calls: 4 }),
      cell({ calls: 2, tool: "kaption_help" }),
      cell({ calls: 3, path: "local", connection: "local-x" }),
      cell({ calls: 1, outcome: "error" }),
    ]);
    const res = await r.call(`/internal/ledger/report?phone=${PHONE}&month=2026-11`, { headers: auth });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain("kaption_help");
    expect(text).not.toContain("grant-a");
    const report = JSON.parse(text) as { month: string; counted: number; tools: { tool: string }[] };
    expect(report.month).toBe("2026-11");
    const window = (await (await r.call(`/internal/ledger/usage?phone=${PHONE}&month=2026-11`, { headers: auth })).json()) as { month: { counted: number } };
    expect(report.counted).toBe(7);
    expect(report.counted).toBe(window.month.counted);
  });

  it("mcp-usage-ledger.READ.3 — a Brazilian line's two written forms are one answer", async () => {
    const r = relayEnv();
    await (await ledgerOf(r, BR_PHONE)).record([cell({ calls: 2 })]);
    await (await ledgerOf(r, brazilMobileVariant(BR_PHONE)!)).record([cell({ calls: 3, path: "local", connection: "local-x" })]);
    const body = (await (await r.call(`/internal/ledger/usage?phone=${BR_PHONE}`, { headers: auth })).json()) as { week: { counted: number; by_source: Record<string, number> } };
    expect(body.week).toMatchObject({ counted: 5, by_source: { cloud: 2, local: 3 } });
  });

  it("mcp-usage-ledger.READ.2, SHADOW.4 — the batch answers each phone once, with its shadow", async () => {
    const r = relayEnv();
    const ledger = await ledgerOf(r);
    await ledger.record([cell({ calls: 25 })]);
    await ledger.shadowAfter(PHONE, NOW, (async () => new Response(JSON.stringify(planAnswer()), { status: 200 })) as never);
    const res = await r.call(`/internal/ledger/usage/batch`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ phones: [PHONE, `+${PHONE}`, "17374202658"], week: "2026-11-09" }),
    });
    const body = (await res.json()) as { accounts: { phone: string; ok: boolean; usage: any }[] };
    expect(body.accounts.map((a) => a.phone)).toEqual([PHONE, "17374202658"]);
    expect(body.accounts[0].usage.shadow.week).toEqual({ limit: 20, over: 5, crossed_at: NOW });
    expect(body.accounts[0].usage.plan).toMatchObject({ tier: "free", enforced_by: "week_ledger" });
    expect(body.accounts[1].usage.week.counted).toBe(0);
  });

  it("mcp-usage-ledger.READ.3 — merging keeps the earliest crossing and the first form's plan", () => {
    const base = (counted: number, crossed: number | null, plan: LedgerWindows["plan"]): LedgerWindows => ({
      week: { period: "2026-11-09", from: "", to: "", counted, by_source: { cloud: counted, local: 0, webmcp: 0 }, refused: 0, total: counted },
      month: null,
      since: "2026-11-09",
      plan,
      crossed: { week: crossed, month: null },
    });
    const plan = { tier: "free" as const, period: "week" as const, limit: 20, pool: null, enforcedBy: "week_ledger" as const, ttlSeconds: 600, fetchedAt: 1 };
    const merged = mergeLedgerWindows([base(15, null, plan), base(10, 50, null)]);
    expect(merged.week!.counted).toBe(25);
    expect(merged.shadow.week).toEqual({ limit: 20, over: 5, crossed_at: 50 });
    expect(merged.shadow.month).toBeNull();
  });
});

describe("global totals split (mcp-usage-ledger.TOTALS)", () => {
  it("mcp-usage-ledger.TOTALS.1 — an account always lands in the same of 16 shards; 1 shard is the old object", () => {
    expect(totalsShardName("acct-a", 16)).toBe(totalsShardName("acct-a", 16));
    expect(totalsShardName("acct-a", 1)).toBe("global");
    const names = new Set(Array.from({ length: 400 }, (_, i) => totalsShardName(`acct-${i}`, 16)));
    expect(names.size).toBe(16);
    expect(totalsNames({})).toHaveLength(17);
    expect(totalsNames({ USAGE_TOTALS_SHARDS: "1" })).toEqual(["global"]);
    expect(totalsNames({ USAGE_TOTALS_SHARDS: "banana" })).toHaveLength(17);
  });

  it("mcp-usage-ledger.TOTALS.2-3 — /admin/usage merges the old object and the shards in the same shape", async () => {
    const r = relayEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      // Days written before the split live in the old object.
      await (r.totals.get("global") as unknown as UsageTotals).add([cell({ hour: Date.UTC(2026, 10, 2, 10), calls: 7 })], "legacy-acct");
      for (let i = 0; i < 30; i++) {
        const ledger = r.ledgers.get(`usage:acct-${i}`) as unknown as UsageLedger;
        await ledger.record([cell({ calls: 1 })], { accountTag: `acct-${i}` });
      }
      await r.ledgers.settle();
      expect(r.totals.names().filter((n) => n.startsWith("global:")).length).toBeGreaterThan(1);
      const body = (await (await r.call("/admin/usage", { headers: auth })).json()) as { rows: any[]; accounts: any[] };
      expect(body.rows).toEqual([
        expect.objectContaining({ day: "2026-11-02", calls: 7 }),
        expect.objectContaining({ day: "2026-11-10", app: "ChatGPT", tool: "query", calls: 30 }),
      ]);
      expect(body.accounts).toEqual([
        { day: "2026-11-02", app: "ChatGPT", accounts: 1 },
        { day: "2026-11-10", app: "ChatGPT", accounts: 30 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * mcp-usage-ledger.HOT_PATH.5-6 — what phase 1 costs, measured. The shadow and the read run inside the account's
 * ledger, after the call was answered (waitUntil), so a call's own latency is unchanged; these are the ledger-side costs
 * on node:sqlite, a full 45-day ledger of a busy account.
 */
describe("phase 1 cost (mcp-usage-ledger.HOT_PATH.5)", () => {
  it("mcp-usage-ledger.HOT_PATH.5 — reports p50/p95 of record, shadow and read on a busy ledger", async () => {
    const r = relayEnv();
    const ledger = await ledgerOf(r);
    const tools = ["query", "send_message", "list_contacts", "get_analytics", "manage_chat", "manage_labels", "summarize_conversation", "get_contact"];
    // 45 days × 24 hours × 8 tools × 2 roads: ~17k hourly cells, ~720 daily cells per tool and road.
    for (let d = 0; d < 45; d++) {
      const cells: UsageCell[] = [];
      for (let h = 0; h < 24; h++) for (const tool of tools) for (const path of ["cloud", "local"] as const) {
        cells.push(cell({ hour: NOW - d * 86_400_000 - h * 3_600_000 - (NOW % 3_600_000), tool, path, connection: path === "cloud" ? "grant-a" : "local-x", calls: 3 }));
      }
      await ledger.record(cells);
    }
    const plan = (async () => new Response(JSON.stringify(planAnswer()), { status: 200 })) as never;
    await ledger.shadowAfter(PHONE, NOW, plan);
    const time = async (n: number, fn: (i: number) => Promise<unknown>) => {
      const samples: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        await fn(i);
        samples.push(performance.now() - t);
      }
      samples.sort((a, b) => a - b);
      return { p50: samples[Math.floor(n * 0.5)], p95: samples[Math.floor(n * 0.95)] };
    };
    const record = await time(300, () => ledger.record([cell({ calls: 1 })]));
    const shadow = await time(300, (i) => ledger.shadowAfter(PHONE, NOW + i, plan));
    const read = await time(300, () => ledger.windows({}, NOW));
    console.log(
      `[HOT_PATH.5] ledger-side cost on a busy 45-day ledger (ms) — record p50 ${record.p50.toFixed(3)} p95 ${record.p95.toFixed(3)}; ` +
        `shadow p50 ${shadow.p50.toFixed(3)} p95 ${shadow.p95.toFixed(3)}; read p50 ${read.p50.toFixed(3)} p95 ${read.p95.toFixed(3)}. ` +
        `Added to a tool call's own path: 0 (all three run after the answer or outside a call).`,
    );
    // Generous bounds: a regression to a full-table scan per call would blow these.
    expect(shadow.p95).toBeLessThan(25);
    expect(read.p95).toBeLessThan(25);
  });
});
