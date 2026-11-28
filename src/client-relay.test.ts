/**
 * mcp-local-hub-growth.CLIENT.3, CLIENT.8 — the cloud relay keeps the MCP session's clientInfo (across an evicted and
 * rehydrated Durable Object), sends it beside every relayed call, and records the normalized client with the call.
 */
import { describe, expect, it, vi } from "vitest";
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
import { FakeKV } from "./test-support/fake-kv";
import type { UsageCell } from "./usage";

function fakeRoom() {
  const room = {
    extras: [] as unknown[],
    async watchManage() { return { manage_kaption: true, plans: true }; },
    async meteringPhone() { return "17373427172"; },
    async handleMcpRequestSettled(_method: string, _params: unknown, extra: unknown) {
      room.extras.push(extra);
      return { ok: true, result: { ok: true } };
    },
  };
  return room;
}

/** Durable Object storage of one MCP session (survives the object being evicted). */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  return { data, get: async (k: string) => data.get(k), put: async (k: string, v: unknown) => void data.set(k, v) };
}

async function agentFor(opts: { storage?: ReturnType<typeof fakeStorage>; kv?: FakeKV; grantId?: string; recorded?: UsageCell[] } = {}) {
  const room = fakeRoom();
  const pending: Promise<unknown>[] = [];
  const env: Record<string, unknown> = {
    OAUTH_KV: opts.kv ?? new FakeKV(),
    RELAY_ROOM: { idFromName: (name: string) => name, get: () => room },
  };
  if (opts.recorded) {
    const recorded = opts.recorded;
    env.USAGE_LEDGER = {
      idFromName: (n: string) => n,
      get: () => ({
        cloudBegin: async () => ({ state: "run", reserved: false, plan: null, use: null }),
        record: async (cells: UsageCell[]) => void recorded.push(...cells),
      }),
    };
  } else {
    env.USAGE_LEDGER_ENABLED = "off";
  }
  const storage = opts.storage ?? fakeStorage();
  const agent = new RelayMCP({ id: { toString: () => "ab".repeat(32) }, storage, waitUntil: (p: Promise<unknown>) => void pending.push(p) } as any, env as any);
  (agent as any).props = { accountRef: "acct_test", ...(opts.grantId ? { grantId: opts.grantId } : {}) };
  await agent.init();
  return { agent, room, storage, settle: () => Promise.all(pending.splice(0)) };
}

async function connectClient(agent: RelayMCP, name: string, version: string) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await (agent as any).server.connect(serverT);
  const client = new Client({ name, version });
  await client.connect(clientT);
  return client;
}

describe("mcp-local-hub-growth.CLIENT.3 the session's client on every relayed call", () => {
  it("mcp-local-hub-growth.CLIENT.3 — the initialize clientInfo is captured, kept in DO storage and sent beside the call", async () => {
    const { agent, room, storage } = await agentFor();
    const client = await connectClient(agent, "claude-ai", "0.1.0");
    const res = (await client.callTool({ name: "query", arguments: { entity: "conversations" } })) as any;
    expect(res.isError).toBeFalsy();
    expect(room.extras).toEqual([{ client: { name: "claude-ai", version: "0.1.0" }, resume: { retry: true } }]); // mcp-bridge-resume.RELAY_HOLD.3 (query is read-only)
    expect(storage.data.get("mcpClientInfo")).toEqual({ name: "claude-ai", version: "0.1.0" });
  });

  it("mcp-local-hub-growth.CLIENT.5 — the clientInfo sent is sanitized", async () => {
    const { agent, room } = await agentFor();
    const client = await connectClient(agent, "  Cursor  <x@y>\n", "1.7.0 beta!");
    await client.callTool({ name: "query", arguments: { entity: "conversations" } });
    expect(room.extras).toEqual([{ client: { name: "Cursor xy", version: "1.7.0beta" }, resume: { retry: true } }]);
  });

  it("mcp-local-hub-growth.CLIENT.3 — after eviction, the rehydrated session sends the kept clientInfo", async () => {
    const storage = fakeStorage({ mcpClientInfo: { name: "Claude Code", version: "2.0.31" } });
    const { agent, room } = await agentFor({ storage });
    // Not initialized in this life: the SDK server knows no client yet.
    await (agent as any).relayToExtension("acct_test", "query", { entity: "conversations" });
    expect(room.extras).toEqual([{ client: { name: "Claude Code", version: "2.0.31" } }]);
  });

  it("mcp-local-hub-growth.CLIENT.3 — after eviction with only the agent's stored initialize request, its clientInfo is used", async () => {
    const storage = fakeStorage({
      initializeRequest: { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } } },
    });
    const { agent, room } = await agentFor({ storage });
    await (agent as any).relayToExtension("acct_test", "query", {}, true);
    expect(room.extras).toEqual([{ metered: true, client: { name: "openai-mcp", version: "1.0.0" } }]);
  });

  it("mcp-local-hub-growth.CLIENT.3 — without clientInfo the name is the OAuth client registration's, version ''", async () => {
    const kv = new FakeKV();
    await kv.put("grant:acct_test:g1", JSON.stringify({ clientId: "c1" }));
    await kv.put("client:c1", JSON.stringify({ clientName: "ChatGPT <connector>" }));
    const { agent, room } = await agentFor({ kv, grantId: "g1" });
    await (agent as any).relayToExtension("acct_test", "query", {});
    expect(room.extras).toEqual([{ client: { name: "ChatGPT connector", version: "" } }]);
  });

  it("mcp-local-hub-growth.CLIENT.3 — with neither, nothing is added beside the call", async () => {
    const { agent, room } = await agentFor();
    await (agent as any).relayToExtension("acct_test", "query", {});
    expect(room.extras).toEqual([{}]);
  });
});

describe("mcp-local-hub-growth.CLIENT.8 the cloud call is recorded with the session's normalized client", () => {
  it("mcp-local-hub-growth.CLIENT.8 — a bare claude client on the cloud is claude-ai; nothing else of the client is recorded (CLIENT.9)", async () => {
    const recorded: UsageCell[] = [];
    const { agent, settle } = await agentFor({ recorded, grantId: "g1" });
    const client = await connectClient(agent, "claude-ai", "0.1.0");
    await client.callTool({ name: "query", arguments: { entity: "messages" } });
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ path: "cloud", connection: "g1", client: "claude-ai", tool: "query" });
    expect(JSON.stringify(recorded[0])).not.toContain("0.1.0");
  });
});
