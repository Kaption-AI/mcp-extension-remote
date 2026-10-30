import { getOAuthApi, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantRefFromToken } from "./connection-lifetime";
import { buildOAuthOptions, createFetchHandler } from "./index";
import { deriveAccountRef } from "./otp";
import { RelayCallError, relayWithAliasSettled } from "./phone-alias";
import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";
import {
  HOUR_MS,
  RepeatDetector,
  buildReport,
  latencyBucket,
  localConnectionId,
  monthRange,
  normalizeCloudApp,
  normalizeLocalApp,
  outcomeOf,
  parseLocalBatch,
  usageKind,
  type UsageCell,
} from "./usage";
import { LedgerStore, TotalsStore, UsageLedger, UsageTotals, type SqlLike } from "./usage-ledger";

const seen = vi.hoisted(() => ({ props: [] as unknown[] }));

vi.mock("./relay-mcp", () => ({
  RelayMCP: {
    serveSSE: () => ({ fetch: async (_r: Request, _e: unknown, ctx: { props?: unknown }) => (seen.props.push(ctx.props), new Response("sse")) }),
    serve: () => ({ fetch: async (_r: Request, _e: unknown, ctx: { props?: unknown }) => (seen.props.push(ctx.props), new Response("mcp")) }),
  },
}));
vi.mock("./relay-room", () => ({ RelayRoom: class RelayRoom {} }));
vi.mock("./deployment-chain", () => ({ DeploymentChainDO: class DeploymentChainDO {} }));

/** Durable Object SQLite storage, played by node:sqlite. */
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
  let alarm: number | null = null;
  const state = {
    storage: {
      sql: sqlite(),
      transactionSync: <T>(fn: () => T) => fn(),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => void (alarm = at),
    },
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  };
  return { state, settle: () => Promise.all(pending.splice(0)), alarm: () => alarm };
}

/** A Durable Object namespace whose objects are real UsageLedger / UsageTotals over node:sqlite. */
function namespace<T>(make: (state: ReturnType<typeof doState>["state"]) => T) {
  const objects = new Map<string, { object: T; settle: () => Promise<unknown> }>();
  const ns = {
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
  return ns;
}

const cell = (over: Partial<UsageCell> = {}): UsageCell => ({
  hour: Date.UTC(2026, 9, 30, 14),
  path: "cloud",
  connection: "grant-a",
  app: "ChatGPT",
  tool: "query",
  kind: "conversations",
  outcome: "ok",
  latency: "1-3s",
  calls: 1,
  repeats: 0,
  ...over,
});

describe("usage vocabulary (mcp-usage-accounting.RECORD)", () => {
  it("names apps as people know them (RECORD.4)", () => {
    expect(normalizeCloudApp("ChatGPT")).toBe("ChatGPT");
    expect(normalizeCloudApp("OpenAI Connector")).toBe("ChatGPT");
    expect(normalizeCloudApp("Claude")).toBe("Claude");
    expect(normalizeCloudApp("claude-code (kaption)")).toBe("Claude Code");
    expect(normalizeCloudApp("Codex CLI")).toBe("Codex");
    expect(normalizeCloudApp("my-script")).toBe("Other");
    expect(normalizeCloudApp(null)).toBe("Other");
    expect(normalizeLocalApp("claude-ai")).toBe("Claude Desktop (local)");
    expect(normalizeLocalApp("claude-code")).toBe("Claude Code (local)");
    expect(normalizeLocalApp("cursor-vscode")).toBe("Cursor (local)");
    expect(normalizeLocalApp("Visual Studio Code")).toBe("VS Code (local)");
    expect(normalizeLocalApp("")).toBe("Local app");
    expect(normalizeLocalApp("zed")).toBe("Other (local)");
    expect(localConnectionId("Claude Desktop (local)")).toBe("local-claude-desktop");
  });

  it("keeps only enum sub-types, never free text (RECORD.2, PRIVACY.1)", () => {
    expect(usageKind("query", { entity: "messages", query: "secret words" })).toBe("messages");
    expect(usageKind("query", { query: "secret words" })).toBe("");
    expect(usageKind("query", { entity: "Alice" })).toBe("");
    expect(usageKind("manage_chat", { action: "archive", chat_id: "123@c.us" })).toBe("archive");
    expect(usageKind("send_message", { to: "123", text: "hi" })).toBe("");
  });

  it("buckets latency coarsely (RECORD.3)", () => {
    expect([10, 999, 1000, 2999, 9999, 29_999, 30_000].map(latencyBucket)).toEqual([
      "<1s", "<1s", "1-3s", "1-3s", "3-10s", "10-30s", ">30s",
    ]);
  });

  it("tells answered, failed, refused, offline and timed-out calls apart (RECORD.5)", () => {
    expect(outcomeOf(null)).toBe("ok");
    expect(outcomeOf(new RelayCallError("You used your actions", -32003))).toBe("refused");
    expect(outcomeOf(new RelayCallError("Extension not connected. Open WhatsApp", "offline"))).toBe("offline");
    expect(outcomeOf(new Error("Extension not connected. Open WhatsApp"))).toBe("offline");
    expect(outcomeOf(new Error("Request timed out after 120s"))).toBe("timeout");
    expect(outcomeOf(new RelayCallError("Chat not found", -32603))).toBe("error");
  });

  it("notices identical repeats within 2 minutes, from digests in memory only (RECORD.6)", async () => {
    const detector = new RepeatDetector();
    const t = Date.UTC(2026, 9, 30, 12);
    expect(await detector.isRepeat("query", { entity: "session" }, t)).toBe(false);
    expect(await detector.isRepeat("query", { entity: "session" }, t + 30_000)).toBe(true);
    expect(await detector.isRepeat("query", { entity: "chats" }, t + 31_000)).toBe(false);
    // Key order does not matter.
    expect(await detector.isRepeat("query", { b: 1, a: 2 }, t + 32_000)).toBe(false);
    expect(await detector.isRepeat("query", { a: 2, b: 1 }, t + 33_000)).toBe(true);
    expect(await detector.isRepeat("query", { entity: "session" }, t + 30_000 + 121_000)).toBe(false);
  });

  it("knows a UTC calendar month (MONTH.1)", () => {
    expect(monthRange("2026-10")).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) });
    expect(monthRange("2026-12")).toEqual({ from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) });
    expect(monthRange("2026-13")).toBeNull();
    expect(monthRange("oct")).toBeNull();
  });
});

describe("local batches (mcp-usage-accounting.LOCAL.8)", () => {
  const now = Date.UTC(2026, 9, 30, 15, 20);
  const row = { hour: Date.UTC(2026, 9, 30, 14), client: "claude-ai", tool: "query", kind: "messages", outcome: "ok", latency: "<1s", calls: 3, repeats: 1 };

  it("accepts valid rows and normalizes the app", () => {
    const parsed = parseLocalBatch({ batchId: "batch_0001", rows: [row] }, now);
    expect(parsed).toEqual({
      batchId: "batch_0001",
      cells: [expect.objectContaining({ path: "local", app: "Claude Desktop (local)", connection: "local-claude-desktop", calls: 3, repeats: 1 })],
    });
  });

  it("refuses the whole batch for one bad row", () => {
    const bad = [
      { ...row, hour: row.hour + 1 },
      { ...row, hour: now - 40 * 24 * HOUR_MS },
      { ...row, hour: now + 3 * HOUR_MS },
      { ...row, tool: "Query; DROP" },
      { ...row, tool: "debug_eval" },
      { ...row, outcome: "great" },
      { ...row, latency: "2s" },
      { ...row, calls: 0 },
      { ...row, calls: 10_001 },
      { ...row, repeats: 4 },
      { ...row, client: "x".repeat(65) },
      { ...row, kind: "Some Text" },
    ];
    for (const r of bad) expect(parseLocalBatch({ batchId: "batch_0001", rows: [row, r] }, now)).toHaveProperty("error");
    expect(parseLocalBatch({ batchId: "short", rows: [row] }, now)).toHaveProperty("error");
    expect(parseLocalBatch({ batchId: "batch_0001", rows: [] }, now)).toHaveProperty("error");
    expect(parseLocalBatch({ batchId: "batch_0001", rows: Array(501).fill(row) }, now)).toHaveProperty("error");
  });

  it("drops a kind that is not one of the tool's enum values", () => {
    const parsed = parseLocalBatch({ batchId: "batch_0001", rows: [{ ...row, kind: "secret" }] }, now);
    expect("cells" in parsed && parsed.cells[0].kind).toBe("");
  });
});

describe("ledger storage (mcp-usage-accounting.STORE, RETAIN)", () => {
  it("adds exactly, by hour and by day, and reports the month", () => {
    const store = new LedgerStore(sqlite());
    const now = Date.UTC(2026, 9, 30, 15);
    store.add([cell(), cell(), cell({ outcome: "error" }), cell({ tool: "send_message", kind: "", repeats: 0 })], now);
    store.add([cell({ hour: Date.UTC(2026, 9, 29, 9), connection: "local-claude-desktop", path: "local", app: "Claude Desktop (local)", calls: 5, repeats: 2 })], now);
    store.add([cell({ hour: Date.UTC(2026, 8, 30, 9), calls: 7 })], now);
    const rows = store.monthRows("2026-10");
    const total = rows.reduce((n, r) => n + r.calls, 0);
    expect(total).toBe(9);
    expect(rows.find((r) => r.tool === "query" && r.outcome === "ok" && r.path === "cloud")?.calls).toBe(2);
    expect(store.since()).toBe("2026-09-30");
    expect(store.hours(Date.UTC(2026, 9, 30), Date.UTC(2026, 9, 31))).toHaveLength(3);
    expect(store.connections().map((c) => c.id).sort()).toEqual(["grant-a", "local-claude-desktop"]);
  });

  it("accepts a batch id once", () => {
    const store = new LedgerStore(sqlite());
    expect(store.claimBatch("local:b1", 1)).toBe(true);
    expect(store.claimBatch("local:b1", 2)).toBe(false);
  });

  it("forgets hourly rows after 45 days and daily rows after 400 days", () => {
    const store = new LedgerStore(sqlite());
    const now = Date.UTC(2026, 9, 30);
    store.add([cell({ hour: now - 50 * 24 * HOUR_MS })], now);
    store.add([cell({ hour: now - 401 * 24 * HOUR_MS, connection: "old" })], now);
    store.prune(now);
    expect(store.hours(0, now)).toHaveLength(0);
    expect(store.monthRows("2026-09")).toHaveLength(1);
    expect(store.connections().map((c) => c.id)).toEqual(["grant-a"]);
  });

  it("keeps global totals without accounts or connections (PRIVACY.4)", () => {
    const totals = new TotalsStore(sqlite());
    totals.add([cell(), cell({ app: "Claude" })], "acct_aaaa");
    totals.add([cell()], "acct_bbbb");
    const report = totals.report("2026-10-01", "2026-11-01");
    expect(report.rows).toHaveLength(2);
    expect(report.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ app: "ChatGPT", calls: 2 }),
        expect.objectContaining({ app: "Claude", calls: 1 }),
      ]),
    );
    expect(JSON.stringify(report)).not.toMatch(/grant-a|acct_/);
    expect(report.accounts.find((a) => a.app === "ChatGPT")?.accounts).toBe(2);
  });
});

describe("the month's report (mcp-usage-accounting.REPORT.1)", () => {
  it("splits by app, connection, tool and day; counted = answered calls", () => {
    const store = new LedgerStore(sqlite());
    const now = Date.UTC(2026, 9, 30, 15);
    store.add([cell(), cell(), cell({ outcome: "refused" }), cell({ connection: "grant-b", app: "Claude", tool: "send_message", kind: "" })], now);
    const report = buildReport("2026-10", store.monthRows("2026-10"), store.connections(), store.since(), new Set(["grant-a"]), now);
    expect(report.counted).toBe(3);
    expect(report.totals).toMatchObject({ calls: 4, ok: 3, refused: 1 });
    expect(report.apps[0]).toEqual({ app: "ChatGPT", path: "cloud", calls: 3, ok: 2 });
    expect(report.connections.find((c) => c.id === "grant-b")?.active).toBe(false);
    expect(report.tools[0]).toEqual({ tool: "query", calls: 3, ok: 2 });
    expect(report.days).toEqual([
      { day: "2026-10-30", app: "ChatGPT", calls: 3, ok: 2 },
      { day: "2026-10-30", app: "Claude", calls: 1, ok: 1 },
    ]);
    expect(report.from).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("relayWithAliasSettled (mcp-usage-accounting.RECORD.5)", () => {
  it("keeps the extension's error code across the Durable Object boundary", async () => {
    const env = {
      OAUTH_KV: new FakeKV(),
      RELAY_ROOM: {
        idFromName: (name: string) => name,
        get: () => ({
          handleMcpRequestSettled: async () => ({ ok: false, message: "You used your 250 actions", code: -32003 }),
        }),
      },
    } as unknown as Env;
    const error = (await relayWithAliasSettled(env, "acct_x", "query", {}).catch((e) => e)) as RelayCallError;
    expect(error).toBeInstanceOf(RelayCallError);
    expect(outcomeOf(error)).toBe("refused");
    expect(error.message).toBe("You used your 250 actions");
  });

  it("answers with the result and follows the alias only when offline", async () => {
    const kv = new FakeKV();
    await kv.put("ref-alias:acct_with", "acct_without");
    const rooms: Record<string, unknown> = {
      acct_with: { handleMcpRequestSettled: async () => ({ ok: false, message: "Extension not connected. Open…", code: "offline" }) },
      acct_without: { handleMcpRequestSettled: async () => ({ ok: true, result: { answered: true } }) },
    };
    const env = { OAUTH_KV: kv, RELAY_ROOM: { idFromName: (n: string) => n, get: (n: string) => rooms[n] } } as unknown as Env;
    expect(await relayWithAliasSettled(env, "acct_with", "query", {})).toEqual({ answered: true });
  });
});

// ─── Routes, over the real OAuth library ───────────────────────────────

const ORIGIN = "https://mcp.kaptionai.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_VERIFIER = "kaption-test-code-verifier-0123456789-abcdefghijklmnop";
const JWT_SECRET = "jwt-secret";
const PHONE_REF_SECRET = "phone-ref-secret";
const PHONE = "5491155551234";
const OTHER_PHONE = "5491155559876";
const NEXT = { fetch: async () => new Response("next") };

function createRelay() {
  const kv = new FakeKV();
  const totals = namespace((state) => new UsageTotals(state as never, {} as Env));
  const env = {
    OAUTH_KV: kv,
    JWT_SECRET,
    PHONE_REF_SECRET,
    INTERNAL_API_KEY: "internal-api-key",
    EPHEMERAL_STATE_SECRET: "ephemeral-state-secret",
    USAGE_TOTALS: totals,
  } as unknown as Env;
  const ledgers = namespace((state) => new UsageLedger(state as never, env));
  (env as { USAGE_LEDGER: unknown }).USAGE_LEDGER = ledgers;
  const handler = createFetchHandler(NEXT);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`${ORIGIN}${path}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    await ledgers.settle();
    return response;
  };
  return { kv, env, ledgers, totals, call, helpers: getOAuthApi(buildOAuthOptions(ORIGIN, NEXT), env) as OAuthHelpers };
}

async function register(relay: ReturnType<typeof createRelay>, clientName: string): Promise<string> {
  const response = await relay.call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  return ((await response.json()) as { client_id: string }).client_id;
}

async function connect(relay: ReturnType<typeof createRelay>, clientId: string, userId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CODE_VERIFIER)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "kaption:access",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  }).toString();
  const request = await relay.helpers.parseAuthRequest(new Request(authorize));
  const { redirectTo } = await relay.helpers.completeAuthorization({
    request,
    userId,
    scope: request.scope,
    metadata: { label: "WhatsApp", lifetime: "inactive-90d" },
    props: { accountRef: userId, connectionLifetime: "inactive-90d" },
  });
  const response = await relay.call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
      resource: `${ORIGIN}/mcp`,
    }).toString(),
  });
  return (await response.json()) as { access_token: string; refresh_token: string };
}

const kaptionJwt = (phone: string) =>
  new SignJWT({ phone }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(JWT_SECRET));

describe("usage routes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T15:20:00Z"));
    seen.props.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("puts the connection on the MCP session's props (RECORD.7)", async () => {
    const relay = createRelay();
    const account = (await deriveAccountRef(PHONE, PHONE_REF_SECRET))!;
    const tokens = await connect(relay, await register(relay, "ChatGPT"), account);
    const response = await relay.call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(await response.text()).toBe("mcp");
    expect(seen.props.at(-1)).toEqual({
      accountRef: account,
      connectionLifetime: "inactive-90d",
      grantId: grantRefFromToken(tokens.access_token)!.grantId,
    });
  });

  it("reports only the caller's own usage, with this month's calls on each connection (REPORT.1-2, PRIVACY.3)", async () => {
    const relay = createRelay();
    const account = (await deriveAccountRef(PHONE, PHONE_REF_SECRET))!;
    const other = (await deriveAccountRef(OTHER_PHONE, PHONE_REF_SECRET))!;
    const tokens = await connect(relay, await register(relay, "ChatGPT"), account);
    const grantId = grantRefFromToken(tokens.access_token)!.grantId;
    const hour = Date.UTC(2026, 9, 30, 15);
    await relay.ledgers.get(`usage:${account}`).record([cell({ hour, connection: grantId }), cell({ hour, connection: grantId, outcome: "error" })]);
    await relay.ledgers.get(`usage:${other}`).record([cell({ hour, connection: "theirs", calls: 99 })]);

    expect((await relay.call("/ext/usage")).status).toBe(401);
    const headers = { Authorization: `Bearer ${await kaptionJwt(PHONE)}` };
    const response = await relay.call("/ext/usage", { headers });
    expect(response.status).toBe(200);
    const report = (await response.json()) as { counted: number; totals: { calls: number }; connections: { id: string; active: boolean }[]; since: string };
    expect(report).toMatchObject({ month: "2026-10", counted: 1, totals: { calls: 2 }, since: "2026-10-30" });
    expect(report.connections).toEqual([expect.objectContaining({ id: grantId, active: true })]);
    expect((await relay.call("/ext/usage?month=2026-9", { headers })).status).toBe(400);
    expect((await (await relay.call("/ext/usage?month=2026-09", { headers })).json()) as { counted: number }).toMatchObject({ counted: 0 });

    const listed = (await (await relay.call("/ext/connections", { headers })).json()) as { connections: { id: string; usage: unknown }[] };
    expect(listed.connections).toEqual([expect.objectContaining({ id: grantId, usage: { month: "2026-10", calls: 2, ok: 1 } })]);
  });

  it("records a local batch once and refuses invalid or oversized batches (LOCAL.5-8)", async () => {
    const relay = createRelay();
    const headers = { Authorization: `Bearer ${await kaptionJwt(PHONE)}`, "Content-Type": "application/json" };
    const body = {
      batchId: "batch_abc123",
      rows: [{ hour: Date.UTC(2026, 9, 30, 14), client: "claude-ai", tool: "query", kind: "messages", outcome: "ok", latency: "<1s", calls: 4 }],
    };
    const post = (b: unknown) => relay.call("/ext/usage/local", { method: "POST", headers, body: typeof b === "string" ? b : JSON.stringify(b) });
    expect(await (await post(body)).json()).toEqual({ ok: true, accepted: 1, duplicate: false });
    expect(await (await post(body)).json()).toEqual({ ok: true, accepted: 0, duplicate: true });
    expect((await post({ ...body, batchId: "batch_bad1", rows: [{ ...body.rows[0], outcome: "nope" }] })).status).toBe(400);
    expect((await post("x".repeat(70 * 1024))).status).toBe(413);
    expect((await relay.call("/ext/usage/local", { method: "POST", body: JSON.stringify(body) })).status).toBe(401);

    const report = (await (await relay.call("/ext/usage", { headers })).json()) as { counted: number; apps: unknown[] };
    expect(report.counted).toBe(4);
    expect(report.apps).toEqual([{ app: "Claude Desktop (local)", path: "local", calls: 4, ok: 4 }]);
  });

  it("serves aggregate totals only with the internal key, without accounts (ADMIN.1-2)", async () => {
    const relay = createRelay();
    const account = (await deriveAccountRef(PHONE, PHONE_REF_SECRET))!;
    await relay.ledgers.get(`usage:${account}`).record([cell({ hour: Date.UTC(2026, 9, 30, 14) })], { accountTag: account });
    await relay.ledgers.settle();
    expect((await relay.call("/admin/usage")).status).toBe(401);
    expect((await relay.call("/admin/usage", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    const response = await relay.call("/admin/usage", { headers: { Authorization: "Bearer internal-api-key" } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ from: "2026-10-01", to: "2026-11-01", rows: [expect.objectContaining({ app: "ChatGPT", calls: 1 })], accounts: [expect.objectContaining({ accounts: 1 })] });
    expect(text).not.toContain(account);
    expect(text).not.toContain("grant-a");
  });
});
