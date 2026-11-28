/**
 * mcp-bridge-resume (Kaption-AI monorepo features/mcp/mcp-bridge-resume.feature.yaml) — the relay room holds Claude's
 * and ChatGPT's calls while the account's bridge reconnects, re-sends a read cut off by a drop, and keeps the tools
 * listed through a reconnect. Off (relay variable or flag row), every room behaves as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./otp", () => ({
  validateJwt: vi.fn(async () => "15555550123"),
  deriveAccountRef: vi.fn(async () => "acct_test"),
  validateExtensionSession: vi.fn(async () => null),
  sanitizeAccountRefForLog: (ref: string) => ref,
  sealState: vi.fn(async (data: unknown) => `sealed:${JSON.stringify(data)}`),
  openState: vi.fn(async () => null),
}));
vi.mock("./phone-alias", () => ({ rememberPhoneAlias: vi.fn(async () => undefined) }));

import { RelayRoom, RESUME_GRACE_MS } from "./relay-room";
import { bridgeResumeOnForPhone, clearBridgeResumeFlagCache } from "./bridge-resume-flag";

type FakeSocket = ReturnType<typeof socket>;
function socket() {
  return {
    sent: [] as string[],
    closed: null as null | { code: number; reason: string },
    attachment: { authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() } as any,
    send(data: string) { this.sent.push(data); },
    close(code: number, reason: string) { this.closed = { code, reason }; },
    serializeAttachment(value: unknown) { this.attachment = value; },
    deserializeAttachment() { return this.attachment; },
    calls() { return this.sent.map((m) => JSON.parse(m)).filter((m) => m.method); },
  };
}

let flagOn = true;
let fetched: string[] = [];

function harness(env: Record<string, unknown> = { MCP_BRIDGE_RESUME: "flags" }) {
  const sockets: FakeSocket[] = [];
  const data = new Map<string, unknown>();
  const refreshed = vi.fn(async () => []);
  let alarmAt: number | null = null;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    setAlarm: async (at: number) => { alarmAt = at; },
  };
  const ctx = { getWebSockets: () => sockets, acceptWebSocket: () => undefined, storage, waitUntil: () => undefined };
  const namespace = { idFromString: (id: string) => id, get: () => ({ refreshManageVisibility: refreshed }) };
  const room = new RelayRoom(ctx as any, { JWT_SECRET: "x", PHONE_REF_SECRET: "y", MCP_OBJECT: namespace, ...env } as any);
  data.set("manage-watchers", { ["a".repeat(32)]: Date.now() });
  const connect = async (features: Record<string, boolean> = { manage_kaption: true }) => {
    const s = socket();
    sockets.push(s);
    await room.webSocketMessage(s as any, JSON.stringify({ type: "auth", jwt: "a.b.c", features }));
    await flush();
    return s;
  };
  const drop = async (s: FakeSocket) => {
    sockets.splice(sockets.indexOf(s), 1);
    await room.webSocketClose(s as any);
    await flush();
  };
  const answer = async (s: FakeSocket, id: number, result: unknown = { ok: true }) => {
    await room.webSocketMessage(s as any, JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  return { room, sockets, data, refreshed, connect, drop, answer, alarmAt: () => alarmAt };
}

const flush = () => vi.advanceTimersByTimeAsync(1);
/** Whether the promise has settled (and how), without waiting for it. */
function settled<T>(p: Promise<T>) {
  const out: { state: "pending" | "resolved" | "rejected"; value?: unknown } = { state: "pending" };
  p.then((value) => Object.assign(out, { state: "resolved", value }), (value) => Object.assign(out, { state: "rejected", value }));
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearBridgeResumeFlagCache();
  flagOn = true;
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ flags: [{ name: "MCP_BRIDGE_RESUME", enabled: flagOn }] }), { status: 200 });
  }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const READ = { resume: { retry: true } };

describe("mcp-bridge-resume.FLAG.2 the relay variable and the flag row", () => {
  it("mcp-bridge-resume.FLAG.2 — unset, empty or off: nothing is asked and the answer is off", async () => {
    const fetchImpl = vi.fn();
    for (const value of [undefined, "", "off"]) {
      expect(await bridgeResumeOnForPhone({ MCP_BRIDGE_RESUME: value }, "15555550123", fetchImpl as any)).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mcp-bridge-resume.FLAG.2 — \"flags\": the flags worker decides for the phone, remembered 5 minutes; a failure is off", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ flags: [{ name: "MCP_BRIDGE_RESUME", remoteEnabled: true }] })));
    expect(await bridgeResumeOnForPhone({ MCP_BRIDGE_RESUME: "flags" }, "+1 555 555 0123", fetchImpl as any, 1_000)).toBe(true);
    expect(await bridgeResumeOnForPhone({ MCP_BRIDGE_RESUME: "flags" }, "15555550123", fetchImpl as any, 2_000)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("phone=15555550123");
    const failing = vi.fn(async () => { throw new Error("down"); });
    expect(await bridgeResumeOnForPhone({ MCP_BRIDGE_RESUME: "flags" }, "15555550999", failing as any)).toBe(false);
  });
});

describe("mcp-bridge-resume.RELAY_HOLD flag off: the room behaves as before", () => {
  it("mcp-bridge-resume.RELAY_HOLD.1 — relay variable unset: a call after a drop answers not connected at once, a cut-off read is rejected, tools hide", async () => {
    const h = harness({});
    const a = await h.connect();
    const call = h.room.handleMcpRequest("query", {}, READ);
    await flush();
    expect(a.calls()[0]).not.toHaveProperty("kaption");
    const cut = settled(call);
    await h.drop(a);
    expect(cut).toMatchObject({ state: "rejected", value: expect.objectContaining({ message: "Extension disconnected" }) });
    await expect(h.room.handleMcpRequest("query", {}, READ)).rejects.toThrow(/^Extension not connected/);
    expect(h.room.manageFeatures()).toBeNull();
    expect(h.data.has("bridge-resume")).toBe(false);
    expect(fetched).toEqual([]);
  });

  it("mcp-bridge-resume.RELAY_HOLD.1 — flag row off for the phone: same as before", async () => {
    flagOn = false;
    const h = harness();
    const a = await h.connect();
    await h.drop(a);
    await expect(h.room.handleMcpRequest("query", {}, READ)).rejects.toThrow(/^Extension not connected/);
    expect(h.room.manageFeatures()).toBeNull();
  });
});

describe("mcp-bridge-resume.RELAY_HOLD flag on", () => {
  it("mcp-bridge-resume.RELAY_HOLD.1, RELAY_HOLD.5 — a call after a drop waits for the bridge and is sent with kaption.resume waited", async () => {
    const h = harness();
    const a = await h.connect();
    await h.drop(a);
    const call = settled(h.room.handleMcpRequest("query", { q: 1 }, READ));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(call.state).toBe("pending");
    const b = await h.connect();
    const sent = b.calls()[0];
    expect(sent).toMatchObject({ method: "query", params: { q: 1 }, kaption: { resume: { kind: "waited", waitMs: expect.any(Number) } } });
    expect(sent.kaption.resume.waitMs).toBeGreaterThanOrEqual(3_000);
    await h.answer(b, sent.id, { rows: 2 });
    await flush();
    expect(call).toEqual({ state: "resolved", value: { rows: 2 } });
  });

  it("mcp-bridge-resume.RELAY_HOLD.1 — no bridge within 20 s: not connected, as before", async () => {
    const h = harness();
    const a = await h.connect();
    await h.drop(a);
    const call = settled(h.room.handleMcpRequest("send_message", {}));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(call).toMatchObject({ state: "rejected", value: expect.objectContaining({ message: expect.stringMatching(/^Extension not connected/) }) });
  });

  it("mcp-bridge-resume.RELAY_HOLD.2 — a bridge last seen over 10 minutes ago (or never) is not waited for", async () => {
    const never = harness();
    const first = settled(never.room.handleMcpRequest("query", {}, READ));
    await flush();
    expect(first.state).toBe("rejected");
    const h = harness();
    const a = await h.connect();
    await h.drop(a);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 1_000);
    const late = settled(h.room.handleMcpRequest("query", {}, READ));
    await flush();
    expect(late).toMatchObject({ state: "rejected", value: expect.objectContaining({ message: expect.stringMatching(/^Extension not connected/) }) });
  });

  it("mcp-bridge-resume.RELAY_HOLD.3, RELAY_HOLD.5 — simulated bridge drop mid-call: the read is re-sent to the new bridge (retried) and answered", async () => {
    const h = harness();
    const a = await h.connect();
    const call = settled(h.room.handleMcpRequest("manage_contacts", { action: "list" }, READ));
    await flush();
    const first = a.calls()[0];
    await h.drop(a);
    expect(call.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(4_000);
    const b = await h.connect();
    const again = b.calls()[0];
    expect(again).toMatchObject({ id: first.id, method: "manage_contacts", params: { action: "list" }, kaption: { resume: { kind: "retried" } } });
    expect(again.kaption.resume.waitMs).toBeGreaterThanOrEqual(4_000);
    await h.answer(b, again.id, { contacts: [] });
    await flush();
    expect(call).toEqual({ state: "resolved", value: { contacts: [] } });
  });

  it("mcp-bridge-resume.RELAY_HOLD.3 — a write cut off by a drop is rejected, never sent twice", async () => {
    const h = harness();
    const a = await h.connect();
    const call = settled(h.room.handleMcpRequest("send_message", { to: "x" }, { metered: true }));
    await flush();
    expect(a.calls()[0].kaption).toEqual({ metered: true });
    await h.drop(a);
    expect(call).toMatchObject({ state: "rejected", value: expect.objectContaining({ message: "Extension disconnected" }) });
    const b = await h.connect();
    expect(b.calls()).toEqual([]);
  });

  it("mcp-bridge-resume.RELAY_HOLD.3 — a read is re-sent only once: a second drop rejects it", async () => {
    const h = harness();
    const a = await h.connect();
    const call = settled(h.room.handleMcpRequest("query", {}, READ));
    await flush();
    await h.drop(a);
    const b = await h.connect();
    expect(b.calls()).toHaveLength(1);
    await h.drop(b);
    expect(call).toMatchObject({ state: "rejected", value: expect.objectContaining({ message: "Extension disconnected" }) });
  });

  it("mcp-bridge-resume.RELAY_HOLD.3 — no bridge back within 20 s: the cut-off read is rejected", async () => {
    const h = harness();
    const a = await h.connect();
    const call = settled(h.room.handleMcpRequest("query", {}, READ));
    await flush();
    await h.drop(a);
    await vi.advanceTimersByTimeAsync(20_500);
    expect(call).toMatchObject({ state: "rejected", value: expect.objectContaining({ message: "Extension disconnected" }) });
  });

  it("mcp-bridge-resume.RELAY_HOLD.4 — the 2-minute timeout runs from when the call arrived, wait included", async () => {
    const h = harness();
    const a = await h.connect();
    await h.drop(a);
    const call = settled(h.room.handleMcpRequest("query", {}, READ));
    await vi.advanceTimersByTimeAsync(15_000);
    await h.connect();
    await vi.advanceTimersByTimeAsync(106_000);
    expect(call).toMatchObject({ state: "rejected", value: expect.objectContaining({ message: "Request timed out after 120s" }) });
  });

  it("mcp-bridge-resume.RELAY_HOLD.6 — the tools stay listed through a reconnect; after 10 minutes without a bridge the sessions are told", async () => {
    const h = harness();
    const a = await h.connect({ manage_kaption: true, plans: true });
    const before = h.refreshed.mock.calls.length;
    await h.drop(a);
    expect(h.room.manageFeatures()).toEqual({ manage_kaption: true, plans: true });
    expect(h.refreshed.mock.calls.length).toBe(before);
    expect(h.alarmAt()).toBe(Date.now() - 1 + RESUME_GRACE_MS);
    const b = await h.connect({ manage_kaption: true, plans: true });
    expect(h.refreshed.mock.calls.length).toBe(before);
    await h.drop(b);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS);
    await h.room.alarm();
    await flush();
    expect(h.room.manageFeatures()).toBeNull();
    expect(h.refreshed.mock.calls.length).toBe(before + 1);
  });

  it("mcp-bridge-resume.RELAY_HOLD.7 — a reconnect asks only the flags worker: never the ledger or /__internal/mcp-ledger/access", async () => {
    const h = harness({ MCP_BRIDGE_RESUME: "flags", INTERNAL_API_BASE_URL: "https://api.example", INTERNAL_API_KEY: "k" });
    const a = await h.connect();
    const call = settled(h.room.handleMcpRequest("query", {}, READ));
    await flush();
    await h.drop(a);
    const b = await h.connect();
    await h.answer(b, b.calls()[0].id);
    await flush();
    expect(call.state).toBe("resolved");
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((url) => url.startsWith("https://flags.kaptionai.com/active?"))).toBe(true);
  });
});
