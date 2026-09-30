/**
 * mcp.CLOUD_RELAY.13 — after hibernation the relay room can still hold the extension's older sockets. The socket that
 * speaks is the one answered (with its own auth state), and once it authenticates the older ones are closed. Before,
 * auth_ok went to an old socket and the extension retried for ever ("Cloud relay unreachable after 5 attempts").
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./otp", () => ({
  validateJwt: vi.fn(async () => "15555550123"),
  deriveAccountRef: vi.fn(async () => "acct_test"),
  validateExtensionSession: vi.fn(async () => null),
  sanitizeAccountRefForLog: (ref: string) => ref,
}));

import { RelayRoom } from "./relay-room";

function socket(attachment: unknown = null) {
  const s = {
    sent: [] as string[],
    closed: null as null | { code: number; reason: string },
    attachment,
    send(data: string) { this.sent.push(data); },
    close(code: number, reason: string) { this.closed = { code, reason }; },
    serializeAttachment(value: unknown) { this.attachment = value; },
    deserializeAttachment() { return this.attachment; },
  };
  return s;
}

function room(sockets: ReturnType<typeof socket>[]) {
  const ctx = { getWebSockets: () => sockets, acceptWebSocket: () => undefined };
  return new RelayRoom(ctx as any, { JWT_SECRET: "x", PHONE_REF_SECRET: "y" } as any);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mcp.CLOUD_RELAY.13 the socket that speaks is the one answered", () => {
  it("auth_ok reaches the new socket, not an old authenticated one; leftover unauthenticated sockets are closed (CLOUD_RELAY.15 keeps other clients)", async () => {
    const stale = socket({ authenticated: true, accountRef: "acct_test", room: "acct_test" });
    const unauthOld = socket({ authenticated: false, accountRef: null, room: "acct_test" });
    const fresh = socket({ authenticated: false, accountRef: null, room: "acct_test" });
    const r = room([stale, unauthOld, fresh]);
    await r.webSocketMessage(fresh as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    expect(fresh.sent.map((m) => JSON.parse(m))).toEqual([{ type: "auth_ok", phone: "15555550123" }]);
    expect(stale.sent).toEqual([]);
    expect(stale.closed).toBeNull();
    expect(unauthOld.closed?.code).toBe(4000);
    expect(fresh.closed).toBeNull();
    expect(fresh.attachment).toEqual({ authenticated: true, accountRef: "acct_test", room: "acct_test", authAt: expect.any(Number) });
  });

  it("a message from a socket that never authenticated is refused on that socket, whatever else is in the room", async () => {
    const stale = socket({ authenticated: true, accountRef: "acct_test" });
    const fresh = socket(null);
    const r = room([stale, fresh]);
    await r.webSocketMessage(fresh as any, JSON.stringify({ type: "ping" }));
    await r.webSocketMessage(fresh as any, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    expect(stale.sent).toEqual([]);
    expect(fresh.sent.map((m) => JSON.parse(m))).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ message: "Not authenticated. Send auth message first." }) }),
      expect.objectContaining({ error: expect.objectContaining({ message: "Not authenticated. Send auth message first." }) }),
    ]);
  });
});

describe("mcp.CLOUD_RELAY.14 a room only authenticates its own account", () => {
  it("a valid session for another account is refused in this room, and the socket closed", async () => {
    const fresh = socket({ authenticated: false, accountRef: null, room: "acct_victim" });
    const r = room([fresh]);
    await r.webSocketMessage(fresh as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    expect(fresh.sent.map((m) => JSON.parse(m))).toEqual([{ type: "auth_error", error: "Invalid or expired JWT" }]);
    expect(fresh.closed?.code).toBe(4001);
    expect(fresh.attachment).toMatchObject({ authenticated: false });
  });

  it("a room that doesn't know whose it is authenticates nobody", async () => {
    const fresh = socket({ authenticated: false, accountRef: null });
    const r = room([fresh]);
    await r.webSocketMessage(fresh as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    expect(fresh.closed?.code).toBe(4001);
  });
});

describe("mcp.CLOUD_RELAY.15 several clients of one account stay connected", () => {
  it("two clients authenticating in turn never close each other; requests go to the newest", async () => {
    const app = socket({ authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() });
    const browser = socket({ authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() });
    const r = room([app, browser]);
    await r.webSocketMessage(app as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await r.webSocketMessage(browser as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    await r.webSocketMessage(app as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    expect(app.closed).toBeNull();
    expect(browser.closed).toBeNull();
    expect(r.isExtensionConnected()).toBe(true);
    const call = r.handleMcpRequest("tools/call", { name: "query" });
    const sentTo = [app, browser].filter((s) => s.sent.some((m) => JSON.parse(m).method === "tools/call"));
    expect(sentTo).toEqual([app]);
    const id = JSON.parse(app.sent.find((m) => JSON.parse(m).method === "tools/call")!).id;
    await r.webSocketMessage(app as any, JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }));
    await expect(call).resolves.toEqual({ ok: true });
  });

  it("an attempt left unauthenticated past 30 s is closed; a fresh one is not", async () => {
    const abandoned = socket({ authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() - 60_000 });
    const handshaking = socket({ authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() });
    const fresh = socket({ authenticated: false, accountRef: null, room: "acct_test", openedAt: Date.now() });
    const r = room([abandoned, handshaking, fresh]);
    await r.webSocketMessage(fresh as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    expect(abandoned.closed?.code).toBe(4000);
    expect(handshaking.closed).toBeNull();
  });

  it("when the serving client leaves, the other one serves; only the closed socket's requests fail", async () => {
    const app = socket({ authenticated: true, accountRef: "acct_test", room: "acct_test", authAt: 1 });
    const browser = socket({ authenticated: true, accountRef: "acct_test", room: "acct_test", authAt: 2 });
    const r = room([app, browser]);
    const first = r.handleMcpRequest("tools/call", { name: "query" });
    expect(browser.sent.length).toBe(1);
    await r.webSocketClose(browser as any);
    await expect(first).rejects.toThrow("Extension disconnected");
    (r as any).ctx.getWebSockets = () => [app];
    const second = r.handleMcpRequest("tools/call", { name: "query" });
    expect(app.sent.length).toBe(1);
    const id = JSON.parse(app.sent[0]).id;
    await r.webSocketMessage(app as any, JSON.stringify({ jsonrpc: "2.0", id, result: 1 }));
    await expect(second).resolves.toBe(1);
  });
});
