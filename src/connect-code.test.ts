/**
 * mcp.CONNECT_CODE — "Add to Claude": a code minted only after the WhatsApp handshake proved the phone, single use,
 * 10 minutes, and never a way around a link Kaption only accepted on trust. Fictional 555 numbers only.
 */
import { describe, expect, it } from "vitest";
import {
  formatConnectCode,
  generateConnectCode,
  maskPhone,
  normalizeConnectCode,
  peekConnectCode,
  pollConnectPairing,
  redeemConnectCode,
  startConnectPairing,
  type ConnectDeps,
} from "./connect-code";

const PHONE = "15555550123";
const OTHER = "15555550199";

function fakeKv() {
  const map = new Map<string, string>();
  return {
    map,
    kv: {
      get: async (key: string) => map.get(key) ?? null,
      put: async (key: string, value: string) => { map.set(key, value); },
      delete: async (key: string) => { map.delete(key); },
    } as unknown as KVNamespace,
  };
}

function world(status: Record<string, unknown> = { confirmed: false, reason: "pending" }) {
  const { kv, map } = fakeKv();
  const calls: Array<{ path: string; body: any }> = [];
  let answer = status;
  const deps: ConnectDeps = {
    kv,
    secret: "s".repeat(32),
    api: async (path, body) => {
      calls.push({ path, body });
      if (path.endsWith("/v3/session")) return { ok: true, status: 200, json: { sessionToken: "kv3_abc", assurance: "unverified" } };
      return { ok: true, status: 200, json: answer };
    },
  };
  return { deps, calls, map, answer: (next: Record<string, unknown>) => { answer = next; } };
}

describe("mcp.CONNECT_CODE.3 the code", () => {
  it("8 characters from an alphabet with nothing that looks like something else", () => {
    for (let i = 0; i < 200; i++) expect(generateConnectCode()).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
  });

  it("reads what people paste: any case, spaces and dashes; refuses anything else", () => {
    expect(normalizeConnectCode(" abcd-2345 ")).toBe("ABCD2345");
    expect(formatConnectCode("ABCD2345")).toBe("ABCD-2345");
    for (const bad of ["ABCD-234", "ABCD-23450", "ABCD-O345", "", 12345678, null]) expect(normalizeConnectCode(bad)).toBeNull();
  });

  it("masks the phone to its country part and last four digits", () => {
    expect(maskPhone(PHONE)).toBe("+1 ••• 0123");
    expect(maskPhone("5511955550123")).toBe("+55 ••• 0123");
  });
});

describe("mcp.CONNECT_CODE.1-2 the handshake", () => {
  it("starts Kaption's WhatsApp handshake for the phone and keeps the pairing", async () => {
    const w = world();
    const started = await startConnectPairing(w.deps, `+${PHONE}`);
    expect(started).toMatchObject({ sessionToken: "kv3_abc" });
    expect(w.calls[0]).toMatchObject({ path: "/api/v5/auth/v3/session", body: { claimedPhone: PHONE } });
    expect(await pollConnectPairing(w.deps, started!.pairId, PHONE)).toEqual({ status: "pending" });
  });

  it("no code while the handshake waits, and none for a link only accepted on trust", async () => {
    const w = world({ confirmed: true, proven: false });
    const { pairId } = (await startConnectPairing(w.deps, PHONE))!;
    expect(await pollConnectPairing(w.deps, pairId, PHONE)).toEqual({ status: "unproven" });
    // The pairing is gone: nothing to poll into a code later.
    w.answer({ confirmed: true, proven: true });
    expect(await pollConnectPairing(w.deps, pairId, PHONE)).toEqual({ status: "expired" });
  });

  it("a proven phone gets a code, the same one on every later poll", async () => {
    const w = world({ confirmed: true, proven: true });
    const { pairId } = (await startConnectPairing(w.deps, PHONE))!;
    const ready = await pollConnectPairing(w.deps, pairId, PHONE);
    expect(ready).toMatchObject({ status: "ready", masked: "+1 ••• 0123" });
    const again = await pollConnectPairing(w.deps, pairId, PHONE);
    expect(again).toMatchObject({ status: "ready", code: (ready as any).code });
  });

  it("only the phone that started it can read it", async () => {
    const w = world({ confirmed: true, proven: true });
    const { pairId } = (await startConnectPairing(w.deps, PHONE))!;
    expect(await pollConnectPairing(w.deps, pairId, OTHER)).toEqual({ status: "expired" });
    expect(await pollConnectPairing(w.deps, "not-a-pair", PHONE)).toEqual({ status: "expired" });
  });

  it("a rejected or expired handshake ends the pairing; needs_code is reported as it is", async () => {
    for (const reason of ["rejected", "expired", "needs_code"]) {
      const w = world({ confirmed: false, reason });
      const { pairId } = (await startConnectPairing(w.deps, PHONE))!;
      expect(await pollConnectPairing(w.deps, pairId, PHONE)).toEqual({ status: reason });
    }
  });
});

describe("mcp.CONNECT_CODE.3-4 using the code", () => {
  async function minted() {
    const w = world({ confirmed: true, proven: true });
    const { pairId } = (await startConnectPairing(w.deps, PHONE))!;
    const ready = (await pollConnectPairing(w.deps, pairId, PHONE)) as { code: string };
    return { w, code: ready.code };
  }

  it("the sign-in page can see whose code it is without spending it", async () => {
    const { w, code } = await minted();
    expect(await peekConnectCode(w.deps, code)).toBe(PHONE);
    expect(await peekConnectCode(w.deps, code.toLowerCase().replace("-", " "))).toBe(PHONE);
  });

  it("works once", async () => {
    const { w, code } = await minted();
    expect(await redeemConnectCode(w.deps, code)).toBe(PHONE);
    expect(await redeemConnectCode(w.deps, code)).toBeNull();
    expect(await peekConnectCode(w.deps, code)).toBeNull();
  });

  it("a code nobody minted, or a tampered record, is nothing", async () => {
    const { w, code } = await minted();
    expect(await redeemConnectCode(w.deps, "ZZZZ-ZZZZ")).toBeNull();
    const key = `connect-code:${normalizeConnectCode(code)}`;
    w.map.set(key, `${w.map.get(key)}x`);
    expect(await redeemConnectCode(w.deps, code)).toBeNull();
  });
});
