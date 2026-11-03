/**
 * business-plans.TEST_ACCOUNT (kaptionai features/pricing/business-plans.feature.yaml, owner 2026-11-03) — a test
 * account is metered exactly like any other; rest-api charges its separate test balance. The relay only keeps the mark
 * rest-api gives with the allowance and says so in the usage report.
 */
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchHandler } from "./index";
import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";
import { LedgerStore, UsageLedger, UsageTotals, type SqlLike } from "./usage-ledger";
import { MeterStore, fetchAllowance, type HoldInput } from "./meter";

vi.mock("./relay-mcp", () => ({ RelayMCP: { serveSSE: () => ({ fetch: async () => new Response("sse") }), serve: () => ({ fetch: async () => new Response("mcp") }) } }));
vi.mock("./relay-room", () => ({ RelayRoom: class RelayRoom {} }));
vi.mock("./deployment-chain", () => ({ DeploymentChainDO: class DeploymentChainDO {} }));

function sqlite(db = new DatabaseSync(":memory:")): SqlLike {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const rows = /^\s*(SELECT|PRAGMA)/i.test(query) ? (statement.all(...(bindings as never[])) as Record<string, unknown>[]) : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows };
    },
  };
}

const NOW = Date.UTC(2026, 10, 3, 12, 0);
const JWT_SECRET = "jwt-secret";
const PHONE = "17374202658";
const kaptionJwt = (phone: string) =>
  new SignJWT({ phone }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(JWT_SECRET));
const hold = (actionId: string): HoldInput => ({ actionId, path: "cloud", connection: "grant1", app: "Claude", tool: "query", kind: "messages" });

function ledgerObject() {
  const state = {
    storage: { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined },
    waitUntil: () => undefined,
  };
  return new UsageLedger(state as never, {} as Env);
}

function relayWith(vars: Partial<Env>) {
  const ledgers = new Map<string, UsageLedger>();
  const env = {
    OAUTH_KV: new FakeKV(),
    JWT_SECRET,
    PHONE_REF_SECRET: "phone-ref-secret",
    INTERNAL_API_BASE_URL: "https://rest.test",
    INTERNAL_API_KEY: "write-key",
    EPHEMERAL_STATE_SECRET: "eph",
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
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = async (method: string, path: string, jwt: string, body?: unknown) =>
    handler(new Request(`https://mcp.kaptionai.com${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, ctx);
  return { env, ledgers, call };
}

function restApi(allowance: Record<string, unknown>) {
  const calls: { path: string; body: any }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body));
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/allowance")) return Response.json(allowance);
    if (url.pathname.endsWith("/charge")) return Response.json({ allowed: true, duplicate: false, balance_millicents: 99_500, cap_cents: 1000, month_spent_millicents: 500, test: true });
    return Response.json({ released: true });
  }) as typeof fetch;
  return { calls, impl };
}

describe("business-plans.TEST_ACCOUNT the relay keeps rest-api's test mark", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("business-plans.TEST_ACCOUNT.3 — the allowance answer's test true is read and kept with the cached allowance", async () => {
    const rest = restApi({ metered: true, plan: "business", allowance: 2, price_millicents: 500, ttl_seconds: 600, test: true });
    const a = await fetchAllowance({ INTERNAL_API_BASE_URL: "https://rest.test", INTERNAL_API_KEY: "k" }, PHONE, rest.impl);
    expect(a).toEqual({ metered: true, plan: "business", allowance: 2, priceMillicents: 500, ttlSeconds: 600, test: true });
    const real = await fetchAllowance({ INTERNAL_API_BASE_URL: "https://rest.test", INTERNAL_API_KEY: "k" }, PHONE, restApi({ metered: true, plan: "business", allowance: 2, price_millicents: 500 }).impl);
    expect(real?.test).toBeUndefined();
    const sql = sqlite();
    new LedgerStore(sql);
    const meter = new MeterStore(sql);
    meter.setAllowance(a!, NOW);
    expect(meter.allowance(NOW)?.test).toBe(true);
    expect(meter.isTest("2026-11")).toBe(true);
    expect(meter.isTest("2026-12")).toBe(false);
    // business-plans.TEST_ACCOUNT.4 — and is metered exactly the same: included, included, then charged.
    expect(meter.reserve(hold("cloud:a1"), NOW)).toMatchObject({ state: "included" });
    expect(meter.reserve(hold("cloud:a2"), NOW)).toMatchObject({ state: "included" });
    expect(meter.reserve(hold("cloud:a3"), NOW)).toMatchObject({ state: "charge" });
  });

  it("business-plans.TEST_ACCOUNT.3 — a ledger made before the mark existed gets the column and keeps its allowance", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE meter_allowance (
      id INTEGER PRIMARY KEY CHECK (id = 1), month TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_s INTEGER NOT NULL,
      metered INTEGER NOT NULL, plan TEXT, allowance INTEGER, price_mc INTEGER)`);
    db.exec(`INSERT INTO meter_allowance VALUES (1, '2026-11', ${NOW}, 600, 1, 'pro', 250, 1000)`);
    const meter = new MeterStore(sqlite(db));
    expect(meter.allowance(NOW)).toEqual({ metered: true, plan: "pro", allowance: 250, priceMillicents: 1000, ttlSeconds: 600 });
    expect(meter.isTest("2026-11")).toBe(false);
    // Constructing again (every Durable Object start) is harmless.
    expect(() => new MeterStore(sqlite(db))).not.toThrow();
  });

  it("business-plans.TEST_ACCOUNT.10 — GET /ext/usage says test true for a test account, and nothing for a real one", async () => {
    const rest = restApi({ metered: true, plan: "business", allowance: 1, price_millicents: 500, ttl_seconds: 600, test: true });
    vi.stubGlobal("fetch", rest.impl);
    const relay = relayWith({ MCP_OVERAGE_LEDGER: "on" });
    const jwt = await kaptionJwt(PHONE);
    const meter = await relay.call("POST", "/ext/usage/meter", jwt, { actionId: "act-00000001", tool: "query", client: "claude-ai" });
    expect(await meter.json()).toMatchObject({ metered: true, allowed: true, included: true });
    await relay.call("POST", "/ext/usage/meter/settle", jwt, { actionId: "act-00000001", outcome: "ok", latency: "<1s" });
    // business-plans.TEST_ACCOUNT.4 — past the allowance it is charged through rest-api like any account.
    const extra = await relay.call("POST", "/ext/usage/meter", jwt, { actionId: "act-00000002", tool: "query", client: "claude-ai" });
    expect(await extra.json()).toMatchObject({ metered: true, allowed: true, included: false });
    expect(rest.calls.some((c) => c.path.endsWith("/charge"))).toBe(true);
    const report = (await (await relay.call("GET", "/ext/usage", jwt)).json()) as any;
    expect(report.test).toBe(true);

    vi.stubGlobal("fetch", restApi({ metered: true, plan: "business", allowance: 1, price_millicents: 500, ttl_seconds: 600 }).impl);
    const other = relayWith({ MCP_OVERAGE_LEDGER: "on" });
    const otherJwt = await kaptionJwt("15555550101");
    await other.call("POST", "/ext/usage/meter", otherJwt, { actionId: "act-00000003", tool: "query", client: "claude-ai" });
    expect(((await (await other.call("GET", "/ext/usage", otherJwt)).json()) as any).test).toBeUndefined();
  });

  it("business-plans.TEST_ACCOUNT.13 — with the relay switch off nothing is asked or marked", async () => {
    const rest = restApi({ metered: true, plan: "business", allowance: 1, price_millicents: 500, test: true });
    vi.stubGlobal("fetch", rest.impl);
    const relay = relayWith({});
    const jwt = await kaptionJwt(PHONE);
    expect(await (await relay.call("POST", "/ext/usage/meter", jwt, { actionId: "act-00000004", tool: "query" })).json()).toEqual({ metered: false, ttl_seconds: 600 });
    expect(rest.calls).toEqual([]);
    expect(((await (await relay.call("GET", "/ext/usage", jwt)).json()) as any).test).toBeUndefined();
  });
});
