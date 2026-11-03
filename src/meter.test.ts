import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchHandler } from "./index";
import { deriveAccountRef } from "./otp";
import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";
import type { UsageCell } from "./usage";
import { LedgerStore, UsageLedger, UsageTotals, type SqlLike } from "./usage-ledger";
import { MeterStore, meterCall, meterRefusalText, type Allowance, type HoldInput, type MeterLedger } from "./meter";

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
const ALLOW: Allowance = { metered: true, plan: "business", allowance: 3, priceMillicents: 500, ttlSeconds: 600 };
const hold = (actionId: string, over: Partial<HoldInput> = {}): HoldInput => ({
  actionId, path: "cloud", connection: "grant1", app: "Claude", tool: "query", kind: "messages", ...over,
});
const okCell = (over: Partial<UsageCell> = {}): UsageCell => ({
  hour: Date.UTC(2026, 10, 3, 11), path: "cloud", connection: "grant1", app: "Claude", tool: "query", kind: "", outcome: "ok", latency: "<1s", calls: 1, repeats: 0, ...over,
});

function stores() {
  const sql = sqlite();
  return { ledger: new LedgerStore(sql), meter: new MeterStore(sql) };
}

/** A UsageLedger over node:sqlite (synchronous transactions, like a Durable Object's). */
function ledgerObject() {
  const pending: Promise<unknown>[] = [];
  const state = {
    storage: { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined },
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  };
  return new UsageLedger(state as never, {} as Env);
}

/** rest-api's /__internal/mcp-ledger/* as a script. */
function restApi(answers: { allowance?: unknown; allowanceStatus?: number; charge?: (body: any) => { status: number; body: unknown } } = {}) {
  const calls: { path: string; body: any; key: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body));
    calls.push({ path: url.pathname, body, key: new Headers(init.headers).get("X-API-Key") });
    if (url.pathname.endsWith("/allowance")) {
      return Response.json(answers.allowance ?? { metered: true, plan: "business", allowance: 3, price_millicents: 500, ttl_seconds: 600 }, { status: answers.allowanceStatus ?? 200 });
    }
    if (url.pathname.endsWith("/charge")) {
      const a = answers.charge ? answers.charge(body) : { status: 200, body: { allowed: true, duplicate: false } };
      return Response.json(a.body, { status: a.status });
    }
    if (url.pathname.endsWith("/release")) return Response.json({ released: true });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const REST = { INTERNAL_API_BASE_URL: "https://rest.test", INTERNAL_API_KEY: "write-key" };

describe("the ledger's slots (business-plans.MCP_LEDGER.3-4, .8, .12)", () => {
  it("business-plans.MCP_LEDGER.3 — no allowance known: asks; the answer expires after its ttl and at the month's end", () => {
    const { meter } = stores();
    expect(meter.reserve(hold("a-00000001"), NOW)).toEqual({ state: "unknown" });
    meter.setAllowance(ALLOW, NOW);
    expect(meter.allowance(NOW + 599_000)).toMatchObject({ allowance: 3 });
    expect(meter.allowance(NOW + 600_000)).toBeNull();
    meter.setAllowance({ ...ALLOW, ttlSeconds: 86_400 }, Date.UTC(2026, 10, 30, 23, 59));
    expect(meter.allowance(Date.UTC(2026, 11, 1, 0, 1))).toBeNull();
  });

  it("business-plans.MCP_LEDGER.1 — an account answered not metered holds nothing", () => {
    const { meter } = stores();
    meter.setAllowance({ ...ALLOW, metered: false }, NOW);
    expect(meter.reserve(hold("a-00000001"), NOW)).toMatchObject({ state: "off" });
    expect(meter.held("2026-11")).toBe(0);
  });

  it("business-plans.MCP_LEDGER.4 — counted calls of both paths plus running ones decide; past the allowance needs a charge", () => {
    const { ledger, meter } = stores();
    meter.setAllowance(ALLOW, NOW);
    ledger.add([okCell(), okCell({ path: "local", connection: "local-claude-desktop", app: "Claude Desktop (local)" }), okCell({ outcome: "error" })], NOW);
    expect(meter.counted("2026-11")).toBe(2);
    expect(meter.reserve(hold("a-00000001"), NOW)).toMatchObject({ state: "included", used: 3, allowance: 3 });
    expect(meter.reserve(hold("a-00000002"), NOW)).toMatchObject({ state: "charge", used: 4, allowance: 3, charged: false });
    // A repeated action id answers the same decision and holds no second slot.
    expect(meter.reserve(hold("a-00000002"), NOW)).toMatchObject({ state: "charge" });
    expect(meter.held("2026-11")).toBe(2);
  });

  it("business-plans.MCP_LEDGER.8 — a failed call gives its slot back; an answered one moves from running to counted", () => {
    const { ledger, meter } = stores();
    meter.setAllowance({ ...ALLOW, allowance: 1 }, NOW);
    expect(meter.reserve(hold("a-00000001"), NOW).state).toBe("included");
    expect(meter.settle("a-00000001")).toMatchObject({ charged: false, tool: "query" });
    ledger.add([okCell({ outcome: "error" })], NOW);
    expect(meter.reserve(hold("a-00000002"), NOW).state).toBe("included");
    meter.settle("a-00000002");
    ledger.add([okCell()], NOW);
    expect(meter.reserve(hold("a-00000003"), NOW).state).toBe("charge");
  });

  it("business-plans.MCP_LEDGER.12 — a local hold never settled becomes an answered call after 15 minutes; a cloud one is dropped", () => {
    const { meter } = stores();
    meter.setAllowance({ ...ALLOW, ttlSeconds: 3600 }, NOW);
    meter.reserve(hold("l-00000001", { path: "local", connection: "local-cursor", app: "Cursor (local)", tool: "send_message", kind: "" }), NOW);
    meter.reserve(hold("c-00000001"), NOW);
    expect(meter.sweep(NOW + 14 * 60_000)).toEqual([]);
    const cells = meter.sweep(NOW + 16 * 60_000);
    expect(cells).toEqual([expect.objectContaining({ path: "local", tool: "send_message", outcome: "ok", calls: 1, app: "Cursor (local)" })]);
    expect(meter.held("2026-11")).toBe(0);
  });
});

describe("meterCall (business-plans.MCP_LEDGER.2, .5-7, .16)", () => {
  const ledgerOf = (): MeterLedger & { object: UsageLedger } => {
    const object = ledgerObject();
    return Object.assign(object, { object });
  };

  it("business-plans.MCP_LEDGER.2 — asks rest-api once with the phone and the write key, then decides from the cache", async () => {
    const ledger = ledgerOf();
    const rest = restApi();
    const phone = vi.fn(async () => "17374202658");
    expect(await meterCall(REST, ledger, hold("a-00000001"), phone, NOW, rest.impl)).toMatchObject({ metered: true, allowed: true, charged: false });
    expect(await meterCall(REST, ledger, hold("a-00000002"), phone, NOW, rest.impl)).toMatchObject({ metered: true, allowed: true, charged: false });
    expect(rest.calls).toEqual([{ path: "/__internal/mcp-ledger/allowance", body: { phone: "17374202658" }, key: "write-key" }]);
    expect(phone).toHaveBeenCalledTimes(1);
  });

  it("business-plans.MCP_LEDGER.5 — past the allowance it charges with the action id, once per action id", async () => {
    const ledger = ledgerOf();
    const rest = restApi({ allowance: { metered: true, plan: "pro", allowance: 0, price_millicents: 1000 } });
    const phone = async () => "17374202658";
    expect(await meterCall(REST, ledger, hold("a-00000001"), phone, NOW, rest.impl)).toMatchObject({ metered: true, allowed: true, charged: true });
    expect(await meterCall(REST, ledger, hold("a-00000001"), phone, NOW, rest.impl)).toMatchObject({ allowed: true, charged: true });
    expect(rest.calls.filter((c) => c.path.endsWith("/charge"))).toEqual([{ path: "/__internal/mcp-ledger/charge", body: { phone: "17374202658", actionId: "a-00000001" }, key: "write-key" }]);
  });

  it("business-plans.MCP_LEDGER.6 — a refused charge refuses the call and gives the slot back", async () => {
    const ledger = ledgerOf();
    const rest = restApi({ allowance: { metered: true, allowance: 0 }, charge: () => ({ status: 402, body: { allowed: false, reason: "no_credit" } }) });
    expect(await meterCall(REST, ledger, hold("a-00000001"), async () => "1737", NOW, rest.impl)).toMatchObject({ metered: true, allowed: false, reason: "no_credit", allowance: 0 });
    expect(await ledger.meterDrop("a-00000001")).toBeNull();
    for (const reason of ["cap_reached", "cap_zero"] as const) {
      const r = restApi({ allowance: { metered: true, allowance: 0 }, charge: () => ({ status: 402, body: { allowed: false, reason } }) });
      expect(await meterCall(REST, ledgerOf(), hold("a-00000002"), async () => "1737", NOW, r.impl)).toMatchObject({ allowed: false, reason });
    }
  });

  it("business-plans.MCP_LEDGER.7 — a charge that cannot be reached refuses (fails closed)", async () => {
    for (const charge of [() => ({ status: 503, body: { error: "unavailable" } }), () => ({ status: 200, body: { odd: true } })]) {
      const ledger = ledgerOf();
      const rest = restApi({ allowance: { metered: true, allowance: 0 }, charge });
      expect(await meterCall(REST, ledger, hold("a-00000001"), async () => "1737", NOW, rest.impl)).toMatchObject({ allowed: false, reason: "unavailable" });
      expect(await ledger.meterDrop("a-00000001")).toBeNull();
    }
  });

  it("business-plans.MCP_LEDGER.18, NOT_ENFORCED.2 — a switch off after the allowance was cached: the call runs unmetered and the account is not metered again", async () => {
    const ledger = ledgerOf();
    const rest = restApi({ allowance: { metered: true, allowance: 0 }, charge: () => ({ status: 200, body: { allowed: true, metered: false, reason: "not_enforced", ttl_seconds: 600 } }) });
    expect(await meterCall(REST, ledger, hold("a-00000001"), async () => "1737", NOW, rest.impl)).toMatchObject({ metered: false });
    expect(await ledger.meterDrop("a-00000001")).toBeNull();
    expect(await meterCall(REST, ledger, hold("a-00000002"), async () => "1737", NOW + 1000, rest.impl)).toMatchObject({ metered: false });
    expect(rest.calls.filter((c) => c.path.endsWith("/charge"))).toHaveLength(1);
    expect(rest.calls.filter((c) => c.path.endsWith("/allowance"))).toHaveLength(1);
  });

  it("business-plans.MCP_LEDGER.16 — no phone, or rest-api unable to say the allowance: not metered", async () => {
    expect(await meterCall(REST, ledgerOf(), hold("a-00000001"), async () => null, NOW, restApi().impl)).toEqual({ metered: false });
    expect(await meterCall(REST, ledgerOf(), hold("a-00000001"), async () => "1737", NOW, restApi({ allowanceStatus: 500 }).impl)).toEqual({ metered: false });
    expect(await meterCall(REST, ledgerOf(), hold("a-00000001"), async () => "1737", NOW, restApi({ allowance: { metered: false, allowance: null } }).impl)).toMatchObject({ metered: false });
  });

  it("business-plans.MCP_LEDGER.10 — two devices (cloud and a local app) share one allowance", async () => {
    const ledger = ledgerOf();
    const rest = restApi({ allowance: { metered: true, plan: "business", allowance: 2 } });
    const phone = async () => "1737";
    const cloud = await meterCall(REST, ledger, hold("cloud:1"), phone, NOW, rest.impl);
    const local = await meterCall(REST, ledger, hold("local:1", { path: "local", connection: "local-claude-desktop", app: "Claude Desktop (local)" }), phone, NOW, rest.impl);
    const third = await meterCall(REST, ledger, hold("local:2", { path: "local", connection: "local-cursor", app: "Cursor (local)" }), phone, NOW, rest.impl);
    expect([cloud, local, third].map((d) => (d.metered && d.allowed ? d.charged : null))).toEqual([false, false, true]);
  });

  it("business-plans.MCP_LEDGER.6 — the refusal text names the reason in product words, never MCP", () => {
    for (const reason of ["no_credit", "cap_reached", "cap_zero", "overage_off", "unavailable"] as const) {
      const text = meterRefusalText(reason, 500);
      expect(text).not.toMatch(/MCP/);
    }
    expect(meterRefusalText("no_credit", 500)).toMatch(/500 Claude and ChatGPT actions.*Kaption credits/);
  });
});

const JWT_SECRET = "jwt-secret";
const PHONE_REF_SECRET = "phone-ref-secret";
const PHONE = "5491155551234";
const kaptionJwt = (phone: string) =>
  new SignJWT({ phone }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(JWT_SECRET));

function relayWith(vars: Partial<Env>) {
  const ledgers = new Map<string, UsageLedger>();
  const env = {
    OAUTH_KV: new FakeKV(),
    JWT_SECRET,
    PHONE_REF_SECRET,
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
  const post = async (path: string, body: unknown, jwt?: string) =>
    handler(new Request(`https://mcp.kaptionai.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
    }), env, ctx);
  return { env, ledgers, post };
}

describe("the local bridge's meter routes (business-plans.MCP_LEDGER.10-12)", () => {
  let rest: ReturnType<typeof restApi>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    rest = restApi({ allowance: { metered: true, plan: "business", allowance: 1, price_millicents: 500 } });
    vi.stubGlobal("fetch", rest.impl);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("business-plans.MCP_LEDGER.1 — with the relay switch off: not metered, nothing asked", async () => {
    const relay = relayWith({});
    const jwt = await kaptionJwt(PHONE);
    const r = await relay.post("/ext/usage/meter", { actionId: "act-00000001", tool: "query" }, jwt);
    expect(await r.json()).toEqual({ metered: false, ttl_seconds: 600 });
    expect(rest.calls).toEqual([]);
    expect(await (await relay.post("/ext/usage/meter/settle", { actionId: "act-00000001", outcome: "ok", latency: "<1s" }, jwt)).json()).toEqual({ ok: true, settled: false });
  });

  it("business-plans.MCP_LEDGER.10-11 — a Kaption JWT is needed; a bad body is refused", async () => {
    const relay = relayWith({ MCP_OVERAGE_LEDGER: "on" });
    expect((await relay.post("/ext/usage/meter", { actionId: "act-00000001", tool: "query" })).status).toBe(401);
    expect((await relay.post("/ext/usage/meter", { actionId: "x", tool: "query" }, await kaptionJwt(PHONE))).status).toBe(400);
    expect((await relay.post("/ext/usage/meter", { actionId: "act-00000001", tool: "Bad Tool" }, await kaptionJwt(PHONE))).status).toBe(400);
  });

  it("business-plans.MCP_LEDGER.10-12 — included, then charged; settle records the call once; a failed charged call is credited back", async () => {
    const relay = relayWith({ MCP_OVERAGE_LEDGER: "on" });
    const jwt = await kaptionJwt(PHONE);
    const first = await relay.post("/ext/usage/meter", { actionId: "act-00000001", tool: "query", kind: "messages", client: "claude-ai" }, jwt);
    expect(await first.json()).toMatchObject({ metered: true, allowed: true, included: true, allowance: 1 });
    expect(await (await relay.post("/ext/usage/meter/settle", { actionId: "act-00000001", outcome: "ok", latency: "1-3s" }, jwt)).json()).toEqual({ ok: true, settled: true });
    // A repeated settle records nothing more.
    expect(await (await relay.post("/ext/usage/meter/settle", { actionId: "act-00000001", outcome: "ok", latency: "1-3s" }, jwt)).json()).toEqual({ ok: true, settled: false });

    const second = await relay.post("/ext/usage/meter", { actionId: "act-00000002", tool: "send_message", client: "claude-ai" }, jwt);
    expect(await second.json()).toMatchObject({ metered: true, allowed: true, included: false });
    expect(rest.calls.find((c) => c.path.endsWith("/charge"))?.body).toEqual({ phone: PHONE, actionId: "local:act-00000002" });
    await relay.post("/ext/usage/meter/settle", { actionId: "act-00000002", outcome: "error", latency: "<1s" }, jwt);
    expect(rest.calls.find((c) => c.path.endsWith("/release"))?.body).toEqual({ phone: PHONE, actionId: "local:act-00000002" });

    const account = (await deriveAccountRef(PHONE, PHONE_REF_SECRET))!;
    const report = await relay.ledgers.get(`usage:${account}`)!.report("2026-11");
    expect(report.rows.map((r) => [r.tool, r.outcome, r.calls, r.path, r.app, r.kind])).toEqual(
      expect.arrayContaining([["query", "ok", 1, "local", "Claude Desktop (local)", "messages"], ["send_message", "error", 1, "local", "Claude Desktop (local)", ""]]),
    );
    expect(report.rows.reduce((n, r) => n + r.calls, 0)).toBe(2);
  });

  it("business-plans.MCP_PAY.5 — the balance is a hard limit: no credit refuses with the reason", async () => {
    vi.stubGlobal("fetch", restApi({ allowance: { metered: true, allowance: 0 }, charge: () => ({ status: 402, body: { allowed: false, reason: "no_credit" } }) }).impl);
    const relay = relayWith({ MCP_OVERAGE_LEDGER: "on" });
    const r = await relay.post("/ext/usage/meter", { actionId: "act-00000003", tool: "query" }, await kaptionJwt(PHONE));
    expect(await r.json()).toEqual({ metered: true, allowed: false, reason: "no_credit", allowance: 0 });
  });
});
