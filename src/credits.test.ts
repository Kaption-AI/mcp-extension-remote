/**
 * mcp-credits-simple.ASK, FLAG, FREE (kaptionai features/mcp/mcp-credits-simple.feature.yaml) — the relay side of the
 * simple extras: the question at 90% and at the allowance while asking, never again after a yes, US$0 stops, Free is
 * told to subscribe, and allow_extra_actions listed only with the credits block.
 */
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
import { creditsAskLine, creditsRefusal, parseCredits, parsePlan } from "./ledger-windows";
import { UsageLedger, type SqlLike } from "./usage-ledger";
import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";

const PHONE = "17373427172";
const SECRET = "phone-ref-secret";
const REFUSAL = "plain plan words";
const ASK = 'Kaption: {used} of {limit} Claude and ChatGPT actions used. Ask the user: "Extra actions cost 1¢ each, up to US$10.00 a month (you can raise it up to US$40.00). Continue?" If they agree, call allow_extra_actions once; Kaption will not ask again.';
const STOP = "Kaption: this account used all its Claude and ChatGPT actions for now and its limit for extra actions is US$0.00.";
const UPGRADE = "Kaption: extra Claude and ChatGPT actions need a subscription. Tell the user they can subscribe to keep going: https://kaptionai.com/pricing";
let allowAnswer: () => Response = () => Response.json({ ok: true, choice: "keep", message: "Kaption: extra actions are on, at 1¢ each, up to US$10.00 a month." });
const credits = (over: Record<string, unknown> = {}) => ({
  choice: "ask", enforce: true, ask_pct: 90, price_millicents: 1000, cap_cents: 1000, ask_message: ASK, stop_message: null, upgrade_message: null, ...over,
});

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
    if (String(url).endsWith("/__internal/mcp-ledger/allow-extra")) return allowAnswer();
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


const proPlan = (over: Record<string, unknown> = {}) => planAnswer({ tier: "pro", period: "month", limit: 10, enforced_by: "device", enforce: true, ...over });

afterEach(() => vi.unstubAllGlobals());

describe("mcp-credits-simple pure rules", () => {
  it("mcp-credits-simple.FLAG.2 — the block is read defensively; a month plan is enforced with it", () => {
    expect(parseCredits(null)).toBeNull();
    expect(parseCredits({ choice: "maybe" })).toBeNull();
    expect(parseCredits(credits())).toMatchObject({ choice: "ask", enforce: true, askPct: 90, capCents: 1000 });
    expect(parsePlan(proPlan())?.enforce).toBe(false);
    expect(parsePlan(proPlan({ credits: credits() }))?.enforce).toBe(true);
    expect(parsePlan(proPlan({ credits: credits({ enforce: false }) }))?.enforce).toBe(false);
  });

  it("mcp-credits-simple.ASK.1 — the question from 90% while asking only", () => {
    const c = parseCredits(credits())!;
    expect(creditsAskLine(c, 8, 10)).toBeNull();
    expect(creditsAskLine(c, 9, 10)).toContain("9 of 10 Claude and ChatGPT actions used");
    expect(creditsAskLine({ ...c, choice: "keep" }, 9, 10)).toBeNull();
  });

  it("mcp-credits-simple.ASK.2, ASK.5, FREE.1 — the refusal at the allowance", () => {
    expect(creditsRefusal(parseCredits(credits()), 10, 10)).toContain("10 of 10");
    expect(creditsRefusal(parseCredits(credits({ choice: "stop", stop_message: STOP })), 10, 10)).toBe(STOP);
    expect(creditsRefusal(parseCredits(credits({ choice: "free", upgrade_message: UPGRADE })), 10, 10)).toBe(UPGRADE);
    expect(creditsRefusal(parseCredits(credits({ choice: "keep" })), 10, 10)).toBeNull();
    expect(creditsRefusal(null, 10, 10)).toBeNull();
  });
});

describe("mcp-credits-simple.ASK through the relay", () => {
  it("mcp-credits-simple.ASK.1-2 — Pro asking: the question at 90%, and at the allowance the call is refused with it", async () => {
    vi.stubGlobal("fetch", restApi(proPlan({ credits: credits() })).fetcher);
    const w = await world();
    for (let i = 0; i < 8; i++) {
      const r = await w.tool("query", { action: "chats" });
      expect(r.isError).toBeFalsy();
      expect(r.content.some((c: any) => String(c.text).includes("allow_extra_actions"))).toBe(false);
    }
    const ninth = await w.tool("query", { action: "chats" });
    expect(ninth.content.at(-1).text).toContain("9 of 10 Claude and ChatGPT actions used");
    await w.tool("query", { action: "chats" });
    const eleventh = await w.tool("query", { action: "chats" });
    expect(eleventh.isError).toBe(true);
    expect(eleventh.content[0].text).toContain("Error: Kaption: 10 of 10 Claude and ChatGPT actions used");
  });

  it("mcp-credits-simple.ASK.3-4, FLAG.2 — allow_extra_actions is listed with the block, says yes once, the next plan is asked again", async () => {
    let plan: Record<string, unknown> = proPlan({ credits: credits() });
    const api = restApi(() => Response.json(plan));
    vi.stubGlobal("fetch", api.fetcher);
    const w = await world();
    await w.tool("query", { action: "chats" });
    const yes = await w.tool("allow_extra_actions", {});
    expect(yes.isError).toBeFalsy();
    expect(yes.content[0].text).toContain("extra actions are on");
    expect(api.asked.some((u) => u.endsWith("/allow-extra"))).toBe(true);
    // rest-api now answers keep (with the overage block); the cached plan was dropped, so it is read again.
    plan = proPlan({ credits: credits({ choice: "keep", ask_message: null }) });
    const before = api.asked.filter((u) => u.endsWith("/plan")).length;
    for (let i = 0; i < 9; i++) {
      const r = await w.tool("query", { action: "chats" });
      expect(r.content.some((c: any) => String(c.text).includes("allow_extra_actions"))).toBe(false);
    }
    expect(api.asked.filter((u) => u.endsWith("/plan")).length).toBeGreaterThan(before);
  });

  it("mcp-credits-simple.ASK.7 — a refused yes (Free) changes nothing and says to subscribe", async () => {
    allowAnswer = () => Response.json({ ok: false, reason: "free", message: UPGRADE });
    vi.stubGlobal("fetch", restApi(planAnswer({ credits: credits({ choice: "free", enforce: false, ask_message: null, upgrade_message: UPGRADE }) })).fetcher);
    const w = await world();
    await w.tool("query", { action: "chats" });
    const r = await w.tool("allow_extra_actions", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(UPGRADE);
  });

  it("mcp-credits-simple.FREE.1 — Free at its weekly number is told to subscribe", async () => {
    vi.stubGlobal("fetch", restApi(planAnswer({ limit: 1, credits: credits({ choice: "free", enforce: false, ask_message: null, upgrade_message: UPGRADE }) })).fetcher);
    const w = await world();
    await w.tool("query", { action: "chats" });
    expect((await w.tool("query", { action: "chats" })).content[0].text).toBe(`Error: ${UPGRADE}`);
  });

  it("mcp-credits-simple.ASK.5 — a US$0 limit stops at the allowance with its words", async () => {
    vi.stubGlobal("fetch", restApi(proPlan({ limit: 1, credits: credits({ choice: "stop", ask_message: null, stop_message: STOP }) })).fetcher);
    const w = await world();
    await w.tool("query", { action: "chats" });
    expect((await w.tool("query", { action: "chats" })).content[0].text).toBe(`Error: ${STOP}`);
  });

  it("mcp-credits-simple.FLAG.1 — without the block nothing changes: no tool, Pro is not held to its month", async () => {
    vi.stubGlobal("fetch", restApi(proPlan({ limit: 1 })).fetcher);
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await w.tool("query", { action: "chats" })).isError).toBeFalsy();
    const r = await w.tool("allow_extra_actions", {});
    expect(r.isError).toBe(true);
  });
});
