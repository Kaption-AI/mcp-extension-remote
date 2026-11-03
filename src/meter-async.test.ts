/**
 * Metering without waiting (kaptionai features/pricing/business-plans.feature.yaml, MCP_ASYNC): the session view and
 * gate of a cloud call (CloudMeter) and the local bridge's lease (MeterStore.lease, /ext/usage/meter/lease).
 */
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchHandler } from "./index";
import { deriveAccountRef } from "./otp";
import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";
import type { UsageCell } from "./usage";
import { LedgerStore, UsageLedger, UsageTotals, type SqlLike } from "./usage-ledger";
import {
  CloudMeter,
  FAST_IN_FLIGHT_MAX,
  LEASE_SLOTS,
  LEASE_TTL_MS,
  MeterStore,
  chargeInBackground,
  headroomOf,
  type AsyncMeterLedger,
  type HoldInput,
  type LeaseItem,
} from "./meter";

vi.mock("./relay-mcp", () => ({ RelayMCP: { serveSSE: () => ({ fetch: async () => new Response("sse") }), serve: () => ({ fetch: async () => new Response("mcp") }) } }));
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

const NOW = Date.UTC(2026, 10, 3, 12, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ledgerObject(): UsageLedger {
  const state = {
    storage: { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined },
    waitUntil: () => undefined,
  };
  return new UsageLedger(state as never, {} as Env);
}

/** Every ledger call takes `ms` (a Durable Object round trip), and is counted. */
function slowLedger(ledger: UsageLedger, ms: number) {
  const calls: string[] = [];
  const proxy = new Proxy(ledger, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || !prop.startsWith("meter") && prop !== "record") return value;
      return async (...args: unknown[]) => {
        calls.push(prop);
        if (ms) await sleep(ms);
        return value.apply(target, args);
      };
    },
  });
  return { ledger: proxy as unknown as AsyncMeterLedger, calls };
}

/** rest-api's /__internal/mcp-ledger/* as a script, each answer after `delay` ms. */
function restApi(o: { allowance?: unknown; charge?: (body: any, n: number) => { status: number; body: unknown }; delay?: number } = {}) {
  const calls: { path: string; body: any }[] = [];
  let charges = 0;
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body));
    calls.push({ path: url.pathname, body });
    if (o.delay) await sleep(o.delay);
    if (url.pathname.endsWith("/allowance")) return Response.json(o.allowance ?? { metered: true, plan: "business", allowance: 10, price_millicents: 500, ttl_seconds: 600 });
    if (url.pathname.endsWith("/charge")) {
      const a = o.charge ? o.charge(body, ++charges) : { status: 200, body: { allowed: true, duplicate: false, balance_millicents: 100_000, cap_cents: 1000, month_spent_millicents: 0 } };
      return Response.json(a.body, { status: a.status });
    }
    if (url.pathname.endsWith("/release")) return Response.json({ released: true });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const REST = { INTERNAL_API_BASE_URL: "https://rest.test", INTERNAL_API_KEY: "write-key" };
let seq = 0;
const input = (over: Partial<HoldInput> = {}): HoldInput => ({ actionId: `cloud:test-${++seq}-${Math.random().toString(16).slice(2, 10)}`, path: "cloud", connection: "grant1", app: "Claude", tool: "query", kind: "", ...over });
const cellOf = (outcome: UsageCell["outcome"] = "ok"): UsageCell => ({ hour: Date.UTC(2026, 10, 3, 12), path: "cloud", connection: "grant1", app: "Claude", tool: "query", kind: "", outcome, latency: "<1s", calls: 1, repeats: 0 });

function meterOn(ledger: AsyncMeterLedger, rest: ReturnType<typeof restApi>, phone: string | null = "17374202658") {
  return new CloudMeter({ env: REST, ledger: () => ledger, phone: async () => phone, fetch: rest.impl });
}

describe("the session's view and gate (business-plans.MCP_ASYNC.1-9)", () => {
  it("business-plans.MCP_ASYNC.2 — seeded at session start in the background; a call then runs without waiting", async () => {
    const base = ledgerObject();
    const { ledger, calls } = slowLedger(base, 20);
    const rest = restApi();
    const meter = meterOn(ledger, rest);
    await meter.seed();
    expect(meter.view).toMatchObject({ metered: true, allowance: 10, used: 0, priceMc: 500, headroomMc: null });
    calls.length = 0;
    const gate = await meter.begin(input());
    expect(gate).toMatchObject({ metered: true, fast: true, refusal: null });
    expect(gate.waitedMs).toBeLessThan(5);
    expect(calls).toEqual(["meterReserve"]); // running beside the call
    expect(await gate.decision).toMatchObject({ metered: true, allowed: true, charged: false });
  });

  it("business-plans.MCP_ASYNC.1 — not metered: no ledger call, nothing awaited; a dated answer refreshes in the background", async () => {
    const base = ledgerObject();
    const { ledger, calls } = slowLedger(base, 20);
    let now = NOW;
    const rest = restApi({ allowance: { metered: false, plan: null, allowance: null, price_millicents: null, ttl_seconds: 600 } });
    const meter = new CloudMeter({ env: REST, ledger: () => ledger, phone: async () => "1737", fetch: rest.impl, now: () => now });
    await meter.seed();
    expect(meter.view).toMatchObject({ metered: false });
    calls.length = 0;
    for (let i = 0; i < 5; i++) {
      const gate = await meter.begin(input());
      expect(gate).toMatchObject({ metered: false, fast: false });
      expect(gate.waitedMs).toBe(0);
    }
    expect(calls).toEqual([]);
    now += 601_000;
    const gate = await meter.begin(input());
    expect(gate.waitedMs).toBe(0);
    expect(calls).toEqual(["meterPeek"]); // the refresh, in the background
  });

  it("business-plans.MCP_ASYNC.3, .9 — included: relayed at once, the record waits for the reservation and settles the hold", async () => {
    const base = ledgerObject();
    const { ledger } = slowLedger(base, 30);
    const rest = restApi();
    const meter = meterOn(ledger, rest);
    await meter.seed();
    const gates = await Promise.all([1, 2, 3].map(() => meter.begin(input())));
    expect(gates.every((g) => g.fast && g.waitedMs < 5)).toBe(true);
    await Promise.all(gates.map((g, i) => meter.finish(g, cellOf(i === 2 ? "error" : "ok"), "acct")));
    // Two answered calls counted, the failed one gave its slot back, nothing is held.
    expect(await base.meterPeek(Date.now())).toMatchObject({ state: "metered", used: 2 });
  });

  it("business-plans.MCP_ASYNC.4 — extra with known headroom: runs at once, charged in the background with its action id, once", async () => {
    const base = ledgerObject();
    const rest = restApi({ allowance: { metered: true, plan: "business", allowance: 0, price_millicents: 500 } });
    const meter = meterOn(base as unknown as AsyncMeterLedger, rest);
    await meter.seed();
    // Headroom unknown past the allowance: the first extra waits for its charge, which makes the headroom known.
    const first = await meter.begin(input());
    expect(first.fast).toBe(false);
    expect(await first.decision).toMatchObject({ allowed: true, charged: true, headroomMc: 100_000 });
    const second = await meter.begin(input());
    expect(second.fast).toBe(true);
    await second.decision;
    const charges = rest.calls.filter((c) => c.path.endsWith("/charge"));
    expect(charges.map((c) => c.body.actionId)).toEqual([first.actionId, second.actionId]);
  });

  it("business-plans.MCP_ASYNC.5 — waits with no view, near zero headroom, or 4 calls already running", async () => {
    // No view yet (no seed): waits.
    const rest = restApi({ allowance: { metered: true, plan: "business", allowance: 0, price_millicents: 500 } });
    const meter = meterOn(ledgerObject() as unknown as AsyncMeterLedger, rest);
    expect((await meter.begin(input())).fast).toBe(false);
    // Near zero: headroom 2 prices < (1 + margin 4) prices → waits.
    const near = restApi({ allowance: { metered: true, plan: "business", allowance: 0, price_millicents: 500 }, charge: () => ({ status: 200, body: { allowed: true, balance_millicents: 1000, cap_cents: 1000, month_spent_millicents: 0 } }) });
    const m2 = meterOn(ledgerObject() as unknown as AsyncMeterLedger, near);
    await m2.seed();
    await m2.begin(input());
    expect(m2.view?.headroomMc).toBe(1000);
    expect((await m2.begin(input())).fast).toBe(false);
    // 4 running: the 5th waits.
    const { ledger } = slowLedger(ledgerObject(), 40);
    const m3 = meterOn(ledger, restApi());
    await m3.seed();
    const gates = await Promise.all(Array.from({ length: FAST_IN_FLIGHT_MAX + 1 }, () => m3.begin(input())));
    expect(gates.map((g) => g.fast)).toEqual([true, true, true, true, false]);
  });

  it("business-plans.MCP_ASYNC.6-8 — credit runs out mid-burst: the running calls are never stopped, at most 4 run uncharged, the next waits and is refused", async () => {
    const base = ledgerObject();
    const { ledger } = slowLedger(base, 10);
    // Headroom known (5 prices + margin), then the account's credit vanishes elsewhere: every later charge refuses.
    const rest = restApi({
      allowance: { metered: true, plan: "business", allowance: 0, price_millicents: 500 },
      charge: (_b, n) => (n === 1 ? { status: 200, body: { allowed: true, balance_millicents: 500_000, cap_cents: 1000, month_spent_millicents: 0 } } : { status: 402, body: { allowed: false, reason: "no_credit" } }),
    });
    const meter = meterOn(ledger, rest);
    await meter.seed();
    const first = await meter.begin(input());
    await meter.finish(first, cellOf(), "acct");
    const burst = await Promise.all(Array.from({ length: 8 }, () => meter.begin(input())));
    const ran = burst.filter((g) => !g.refusal);
    expect(burst.filter((g) => g.fast).length).toBeLessThanOrEqual(FAST_IN_FLIGHT_MAX);
    const results = await Promise.all(ran.map((g) => meter.finish(g, cellOf(), "acct")));
    const uncharged = results.filter((r) => r.uncharged).length;
    expect(uncharged).toBeLessThanOrEqual(FAST_IN_FLIGHT_MAX);
    expect(uncharged).toBeGreaterThan(0);
    // Every call that waited got the known refusal.
    expect(burst.filter((g) => !g.fast).every((g) => g.refusal?.reason === "no_credit")).toBe(true);
    // The next call waits and is refused (headroom 0 known).
    const next = await meter.begin(input());
    expect(next).toMatchObject({ fast: false, refusal: { reason: "no_credit" } });
    // business-plans.MCP_ASYNC.8 — the bill check: charged + uncharged = counted calls past the allowance (0).
    const report = await base.report("2026-11");
    const counted = report.rows.filter((r) => r.outcome === "ok").reduce((n, r) => n + r.calls, 0);
    expect(1 + report.uncharged).toBe(counted);
  });

  it("business-plans.MCP_ASYNC.9 — a failed call relayed before its charge answered is credited back once", async () => {
    const base = ledgerObject();
    const rest = restApi({ allowance: { metered: true, plan: "business", allowance: 0, price_millicents: 500 } });
    const meter = meterOn(base as unknown as AsyncMeterLedger, rest);
    await meter.seed();
    await meter.finish(await meter.begin(input()), cellOf(), "acct");
    const gate = await meter.begin(input());
    expect(gate.fast).toBe(true);
    await meter.finish(gate, cellOf("error"), "acct");
    expect(rest.calls.filter((c) => c.path.endsWith("/release")).map((c) => c.body.actionId)).toEqual([gate.actionId]);
  });

  it("business-plans.MCP_ASYNC.17 — added latency on the hot path with a 50 ms round trip on every hop", async () => {
    const rtt = 50;
    const measure = async (allowance: number, chargeBody: Record<string, unknown>) => {
      const { ledger } = slowLedger(ledgerObject(), rtt);
      const meter = meterOn(ledger, restApi({ delay: rtt, allowance: { metered: true, plan: "business", allowance, price_millicents: 500 }, charge: () => ({ status: 200, body: { allowed: true, ...chargeBody } }) }));
      await meter.seed();
      await meter.finish(await meter.begin(input()), cellOf(), "acct"); // the first extra makes the headroom known
      const gate = await meter.begin(input());
      await meter.finish(gate, cellOf(), "acct");
      return gate;
    };
    const included = await measure(100, {});
    const extra = await measure(0, { balance_millicents: 100_000, cap_cents: 1000, month_spent_millicents: 0 });
    const nearZero = await measure(0, { balance_millicents: 600, cap_cents: 1000, month_spent_millicents: 0 });
    expect(included).toMatchObject({ fast: true });
    expect(extra).toMatchObject({ fast: true });
    expect(nearZero).toMatchObject({ fast: false });
    expect(included.waitedMs).toBeLessThan(5);
    expect(extra.waitedMs).toBeLessThan(5);
    expect(nearZero.waitedMs).toBeGreaterThanOrEqual(2 * rtt - 5); // the ledger, then the charge
  });

  it("business-plans.MCP_ASYNC.2 — a charge answer's headroom: exact balance and what is left under the cap", () => {
    expect(headroomOf({ balance_millicents: 7000, cap_cents: 10, month_spent_millicents: 4000 })).toBe(6000);
    expect(headroomOf({ balance_cents: 3, cap_cents: 100, month_spent_millicents: 0 })).toBe(2000);
    expect(headroomOf({})).toBeNull();
  });
});

describe("the local lease (business-plans.MCP_ASYNC.10-15)", () => {
  const ALLOW = { metered: true, plan: "business", allowance: 30, priceMillicents: 500, ttlSeconds: 3600 };
  const store = () => {
    const sql = sqlite();
    const meter = new MeterStore(sql);
    // usage_day for counted(): the ledger's own store over the same database.
    const ledger = new LedgerStore(sql);
    meter.setAllowance(ALLOW, NOW);
    return { meter, add: (cells: UsageCell[]) => ledger.add(cells, NOW) };
  };
  const item = (n: number, over: Partial<LeaseItem> = {}): LeaseItem => ({ actionId: `act-${String(n).padStart(8, "0")}`, tool: "query", kind: "", app: "Claude Desktop (local)", outcome: "ok", latency: "<1s", extra: false, ...over });
  const req = (leaseId: string, items: LeaseItem[] = [], keep = true) => ({ leaseId, app: "Claude Desktop (local)", items, keep });

  it("business-plans.MCP_ASYNC.10 — a lease holds at most 20 included slots, counted as running, so two devices share one allowance", () => {
    const { meter, add } = store();
    const a = meter.lease(req("lease-aaaaaaaa"), NOW, add);
    expect(a).toMatchObject({ state: "lease", lease: { included: LEASE_SLOTS, extra: 0, priceMc: 500, expiresInS: 600 } });
    expect(meter.held("2026-11", NOW)).toBe(20);
    const b = meter.lease(req("lease-bbbbbbbb"), NOW, add);
    expect(b).toMatchObject({ lease: { included: 10 } });
    expect(meter.reserve({ actionId: "cloud:x-00000001", path: "cloud", connection: "g", app: "Claude", tool: "query", kind: "" }, NOW)).toMatchObject({ state: "charge" });
  });

  it("business-plans.MCP_ASYNC.11 — an extra budget only with the last slots and a known headroom, never past the headroom left", () => {
    const { meter, add } = store();
    meter.lease(req("lease-aaaaaaaa"), NOW, add);
    expect(meter.lease(req("lease-bbbbbbbb"), NOW, add)).toMatchObject({ lease: { included: 10, extra: 0 } }); // headroom unknown
    meter.setHeadroom(10 * 500, NOW);
    expect(meter.lease(req("lease-bbbbbbbb"), NOW, add)).toMatchObject({ lease: { included: 10, extra: 6 } }); // 10 − 4 margin
    meter.setHeadroom(100 * 500, NOW);
    expect(meter.lease(req("lease-cccccccc"), NOW, add)).toMatchObject({ lease: { included: 0, extra: 10 } }); // capped at 10
    meter.setHeadroom(12 * 500, NOW);
    // 12 prices − 6 (b's unused budget) − 4 = 2.
    expect(meter.lease(req("lease-cccccccc"), NOW, add)).toMatchObject({ lease: { extra: 2 } });
  });

  it("business-plans.MCP_ASYNC.14 — settles record once; answered calls past the allowance are to be charged; failed calls give the slot back", () => {
    const { meter, add } = store();
    meter.setAllowance({ ...ALLOW, allowance: 2 }, NOW);
    meter.setHeadroom(100 * 500, NOW);
    expect(meter.lease(req("lease-aaaaaaaa"), NOW, add)).toMatchObject({ lease: { included: 2, extra: 10 } });
    const r = meter.lease(req("lease-aaaaaaaa", [item(1), item(2, { outcome: "error" }), item(3, { extra: true }), item(4, { extra: true })]), NOW, add);
    // The failed included call freed its slot: extra #3 takes it, #4 is past the allowance.
    expect(r).toMatchObject({ state: "lease", settled: 4, charge: ["local:act-00000004"] });
    const again = meter.lease(req("lease-aaaaaaaa", [item(1), item(4, { extra: true })]), NOW, add);
    expect(again).toMatchObject({ settled: 0, charge: [] });
    expect(meter.counted("2026-11")).toBe(3);
    // keep false closes the lease: nothing held any more.
    meter.lease(req("lease-aaaaaaaa", [], false), NOW, add);
    expect(meter.held("2026-11", NOW)).toBe(0);
  });

  it("business-plans.MCP_ASYNC.15 — a lease that expires unused gives its slots back at once; late settles are still accepted", () => {
    const { meter, add } = store();
    meter.lease(req("lease-aaaaaaaa"), NOW, add);
    expect(meter.held("2026-11", NOW + LEASE_TTL_MS - 1)).toBe(20);
    expect(meter.held("2026-11", NOW + LEASE_TTL_MS)).toBe(0);
    expect(meter.counted("2026-11")).toBe(0);
    const late = meter.lease(req("lease-aaaaaaaa", [item(9)]), NOW + LEASE_TTL_MS + 1000, add);
    expect(late).toMatchObject({ settled: 1, charge: [], lease: { included: 20 } });
    expect(meter.counted("2026-11")).toBe(1);
  });

  it("business-plans.MCP_ASYNC.8, .14 — a background charge refused keeps the action as uncharged; allowed ones update the headroom", async () => {
    const ledger = ledgerObject();
    const rest = restApi({ charge: (b) => (b.actionId.endsWith("2") ? { status: 402, body: { allowed: false, reason: "no_credit" } } : { status: 200, body: { allowed: true, balance_millicents: 4000, cap_cents: 1000, month_spent_millicents: 0 } }) });
    await chargeInBackground(REST, ledger as unknown as AsyncMeterLedger, ["local:act-00000001", "local:act-00000002"], async () => "1737", rest.impl);
    expect((await ledger.report("2026-11")).uncharged).toBe(1);
    expect(await ledger.meterPeek(Date.now())).toMatchObject({ state: "unknown" });
  });
});

const JWT_SECRET = "jwt-secret";
const PHONE_REF_SECRET = "phone-ref-secret";
const PHONE = "5491155551234";
const kaptionJwt = (phone: string) =>
  new SignJWT({ phone }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(JWT_SECRET));

function relayWith(vars: Partial<Env>) {
  const ledgers = new Map<string, UsageLedger>();
  const pending: Promise<unknown>[] = [];
  const env = {
    OAUTH_KV: new FakeKV(),
    JWT_SECRET,
    PHONE_REF_SECRET,
    INTERNAL_API_BASE_URL: "https://rest.test",
    INTERNAL_API_KEY: "write-key",
    USAGE_TOTALS: { idFromName: (n: string) => n, get: () => new UsageTotals({ storage: { sql: sqlite(), transactionSync: (f: () => unknown) => f(), getAlarm: async () => 1, setAlarm: async () => undefined }, waitUntil: () => undefined } as never, {} as Env) },
    USAGE_LEDGER: {
      idFromName: (n: string) => n,
      get: (id: string) => {
        if (!ledgers.has(id)) ledgers.set(id, ledgerObject());
        return ledgers.get(id)!;
      },
    },
    ...vars,
  } as unknown as Env;
  const handler = createFetchHandler({ fetch: async () => new Response("next") });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const post = async (path: string, body: unknown, jwt?: string) =>
    handler(new Request(`https://mcp.kaptionai.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
    }), env, ctx);
  return { env, ledgers, post, drain: () => Promise.all(pending.splice(0)) };
}

describe("the lease route (business-plans.MCP_ASYNC.10-16)", () => {
  let rest: ReturnType<typeof restApi>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    rest = restApi({ allowance: { metered: true, plan: "business", allowance: 2, price_millicents: 500, ttl_seconds: 600 } });
    vi.stubGlobal("fetch", rest.impl);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("business-plans.MCP_ASYNC.1 — with the relay switch off: not metered, nothing asked", async () => {
    const relay = relayWith({});
    const r = await relay.post("/ext/usage/meter/lease", { leaseId: "lease-00000001" }, await kaptionJwt(PHONE));
    expect(await r.json()).toEqual({ metered: false, ttl_seconds: 600 });
    expect(rest.calls).toEqual([]);
  });

  it("business-plans.MCP_ASYNC.10, .14 — a JWT and valid rows are needed; a lease, then settles charged in the background past the allowance", async () => {
    const relay = relayWith({ MCP_OVERAGE_LEDGER: "on" });
    const jwt = await kaptionJwt(PHONE);
    expect((await relay.post("/ext/usage/meter/lease", { leaseId: "lease-00000001" })).status).toBe(401);
    expect((await relay.post("/ext/usage/meter/lease", { leaseId: "x" }, jwt)).status).toBe(400);
    expect((await relay.post("/ext/usage/meter/lease", { leaseId: "lease-00000001", settle: [{ actionId: "act-00000001", tool: "Bad", outcome: "ok" }] }, jwt)).status).toBe(400);
    const first = await (await relay.post("/ext/usage/meter/lease", { leaseId: "lease-00000001", client: "claude-ai" }, jwt)).json();
    expect(first).toMatchObject({ metered: true, settled: 0, lease: { id: "lease-00000001", included: 2, extra: 0, price_millicents: 500, expires_in_s: 600, allowance: 2 } });
    const settle = [1, 2, 3].map((n) => ({ actionId: `act-0000000${n}`, tool: "query", outcome: "ok", latency: "<1s", extra: n === 3, client: "claude-ai" }));
    const second = await (await relay.post("/ext/usage/meter/lease", { leaseId: "lease-00000001", settle, client: "claude-ai" }, jwt)).json();
    expect(second).toMatchObject({ metered: true, settled: 3 });
    await relay.drain();
    expect(rest.calls.filter((c) => c.path.endsWith("/charge")).map((c) => c.body)).toEqual([{ phone: PHONE, actionId: "local:act-00000003" }]);
    const account = (await deriveAccountRef(PHONE, PHONE_REF_SECRET))!;
    const report = await relay.ledgers.get(`usage:${account}`)!.report("2026-11");
    expect(report.rows.reduce((n, r) => n + r.calls, 0)).toBe(3);
    expect(report.rows[0]).toMatchObject({ path: "local", app: "Claude Desktop (local)" });
  });

  it("business-plans.MCP_ASYNC.16 — the per-call meter answers as before beside a lease", async () => {
    const relay = relayWith({ MCP_OVERAGE_LEDGER: "on" });
    const jwt = await kaptionJwt(PHONE);
    await relay.post("/ext/usage/meter/lease", { leaseId: "lease-00000001" }, jwt);
    // The lease holds both included slots: the per-call meter's call is past the allowance (charged).
    expect(await (await relay.post("/ext/usage/meter", { actionId: "act-00000009", tool: "query" }, jwt)).json()).toMatchObject({ metered: true, allowed: true, included: false });
  });
});
