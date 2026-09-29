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
  it("auth_ok reaches the new socket, not an old authenticated one, and the old ones are closed", async () => {
    const stale = socket({ authenticated: true, accountRef: "acct_test" });
    const unauthOld = socket({ authenticated: false, accountRef: null });
    const fresh = socket({ authenticated: false, accountRef: null });
    const r = room([stale, unauthOld, fresh]);
    await r.webSocketMessage(fresh as any, JSON.stringify({ type: "auth", jwt: "a.b.c" }));
    await flush();
    expect(fresh.sent.map((m) => JSON.parse(m))).toEqual([{ type: "auth_ok", phone: "15555550123" }]);
    expect(stale.sent).toEqual([]);
    expect(stale.closed).toEqual({ code: 4000, reason: "Replaced by a newer connection" });
    expect(unauthOld.closed?.code).toBe(4000);
    expect(fresh.closed).toBeNull();
    expect(fresh.attachment).toEqual({ authenticated: true, accountRef: "acct_test" });
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
