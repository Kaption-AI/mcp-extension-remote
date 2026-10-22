/**
 * AR-ACT-02 — rate limits the relay really counts: 429 problem+json with
 * Retry-After, and RateLimit-* headers on the answers that count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumed,
  fixedWindowStatus,
  mostRestrictive,
  rateLimitHeaders,
  readSlidingCounter,
  slidingStatus,
  tooManyRequests,
  writeSlidingCounter,
} from "./rate-limit";
import { deprecationHeaders, ensureProblemJson, problem, withDeprecation } from "./problem";

const state = vi.hoisted(() => ({ env: {} as any }));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: state.env }),
}));

import { POST as sendOtp } from "@/app/authorize/send-otp/route";
import { POST as rememberCode } from "@/app/connect/remember/route";

function memoryKv() {
  const map = new Map<string, { value: string; metadata?: unknown }>();
  const kv = {
    get: vi.fn(async (key: string) => map.get(key)?.value ?? null),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: map.get(key)?.value ?? null,
      metadata: map.get(key)?.metadata ?? null,
    })),
    put: vi.fn(async (key: string, value: string, opts?: { metadata?: unknown }) => {
      map.set(key, { value, metadata: opts?.metadata });
    }),
    delete: vi.fn(async (key: string) => {
      map.delete(key);
    }),
  };
  return { map, kv: kv as unknown as KVNamespace };
}

function post(path: string, body: unknown, ip = "192.0.2.10"): Request {
  return new Request(`https://mcp.kaptionai.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

describe("rate-limit state", () => {
  it("reads a fixed window: fresh, partly used, elapsed", () => {
    const now = 1_000_000_000_000;
    expect(fixedWindowStatus(null, "p", 50, 3600, now)).toMatchObject({ remaining: 50, resetSeconds: 3600 });
    const used = JSON.stringify({ count: 20, windowStart: now - 600_000 });
    expect(fixedWindowStatus(used, "p", 50, 3600, now)).toMatchObject({ remaining: 30, resetSeconds: 3000 });
    const old = JSON.stringify({ count: 50, windowStart: now - 3_700_000 });
    expect(fixedWindowStatus(old, "p", 50, 3600, now)).toMatchObject({ remaining: 50 });
  });

  it("keeps sliding counters as plain numbers and the expiry in metadata", async () => {
    const { kv, map } = memoryKv();
    const now = 1_000_000_000_000;
    await writeSlidingCounter(kv, "k", 3, 600, now);
    expect(map.get("k")).toEqual({ value: "3", metadata: { expiresAt: now + 600_000 } });
    const counter = await readSlidingCounter(kv, "k", now + 100_000);
    expect(slidingStatus(counter, "p", 20, 600, now + 100_000)).toMatchObject({ remaining: 17, resetSeconds: 500 });
  });

  it("without metadata (an older write) reports the whole window as the bound", async () => {
    const kv = { get: vi.fn(async () => "5") } as unknown as KVNamespace;
    expect(slidingStatus(await readSlidingCounter(kv, "k"), "p", 20, 600)).toMatchObject({ remaining: 15, resetSeconds: 600 });
  });

  it("reports the policy closest to running out and lists every policy", () => {
    const account = consumed(fixedWindowStatus(null, "a", 50, 3600));
    const ip = consumed(fixedWindowStatus(JSON.stringify({ count: 98, windowStart: Date.now() - 1000 }), "i", 100, 3600));
    expect(mostRestrictive(account, ip).policy).toBe("i");
    expect(rateLimitHeaders(account, ip)).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "1",
      "RateLimit-Reset": "3599",
      "RateLimit-Policy": "50;w=3600, 100;w=3600",
    });
  });

  it("a 429 is problem+json with Retry-After", async () => {
    const response = tooManyRequests(
      { policy: "p", limit: 3, windowSeconds: 600, remaining: 0, resetSeconds: 42 },
      "Slow down",
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(await response.json()).toEqual({
      type: "https://kaptionai.com/developers/#errors-rate_limited",
      title: "Too Many Requests",
      status: 429,
      detail: "Slow down",
      code: "rate_limited",
      policy: "p",
      retry_after: 42,
    });
  });
});

describe("OTP send limits on /authorize/send-otp", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    const { kv } = memoryKv();
    state.env = {
      OAUTH_KV: kv,
      PHONE_REF_SECRET: "phone-ref-secret",
      EPHEMERAL_STATE_SECRET: "ephemeral-state-secret",
      INTERNAL_API_BASE_URL: "https://api.example.test",
      INTERNAL_API_KEY: "internal-api-key",
    };
  });

  it("counts a send and says so in RateLimit headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const response = await sendOtp(post("/authorize/send-otp", { phone: "15555550123", oauthReqInfo: "signed" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit-limit")).toBe("50");
    expect(response.headers.get("ratelimit-remaining")).toBe("49");
    expect(response.headers.get("ratelimit-reset")).toBe("3600");
    expect(response.headers.get("ratelimit-policy")).toBe("50;w=3600, 100;w=3600");
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("an address over its hourly allowance gets 429 + Retry-After, and the page still gets its message", async () => {
    const windowStart = Date.now() - 600_000;
    await state.env.OAUTH_KV.put("rate:otp-ip:192.0.2.10", JSON.stringify({ count: 100, windowStart }));
    const response = await sendOtp(post("/authorize/send-otp", { phone: "15555550123", oauthReqInfo: "signed" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const retryAfter = Number(response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(2990);
    expect(retryAfter).toBeLessThanOrEqual(3000);
    expect(response.headers.get("ratelimit-limit")).toBe("100");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(await response.json()).toMatchObject({
      status: 429,
      code: "rate_limited",
      policy: "otp-send-ip",
      error: "Too many requests. Try again later.",
      errorKey: "err.too_many_requests",
    });
  });

  it("a bad body is problem+json with a code", async () => {
    const response = await sendOtp(post("/authorize/send-otp", { phone: "" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 400, code: "invalid_input", error: expect.any(String) });
  });
});

describe("connect-code wrong-code limit on /connect/remember", () => {
  it("counts only wrong codes and reports what is left", async () => {
    const { kv } = memoryKv();
    state.env = { OAUTH_KV: kv, EPHEMERAL_STATE_SECRET: "s".repeat(32), INTERNAL_API_BASE_URL: "https://api.example.test" };
    const response = await rememberCode(post("/connect/remember", { code: "ABCD-2345" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("ratelimit-limit")).toBe("20");
    expect(response.headers.get("ratelimit-remaining")).toBe("19");
    expect(response.headers.get("ratelimit-reset")).toBe("600");
    expect(await response.json()).toMatchObject({ code: "connect_code_expired", errorKey: "err.code_expired" });
  });
});

describe("problem helpers", () => {
  it("leaves JSON answers and MCP transport answers alone", async () => {
    const oauth = Response.json({ error: "invalid_grant" }, { status: 400 });
    expect(await ensureProblemJson(oauth, new Request("https://mcp.kaptionai.com/token"))).toBe(oauth);
    const rpc = new Response('{"jsonrpc":"2.0","error":{"code":-32000,"message":"x"},"id":null}', { status: 400 });
    expect(await ensureProblemJson(rpc, new Request("https://mcp.kaptionai.com/mcp"))).toBe(rpc);
  });

  it("keeps a short plain-text reason as detail", async () => {
    const converted = await ensureProblemJson(
      new Response("Missing sessionId", { status: 400 }),
      new Request("https://mcp.kaptionai.com/somewhere"),
    );
    expect(await converted.json()).toMatchObject({ status: 400, code: "bad_request", detail: "Missing sessionId" });
  });

  it("extension members never override the core members", async () => {
    const body = await problem({ status: 500, code: "internal_error", extra: { status: "error", code: "x" } }).json();
    expect(body).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("builds Deprecation, Sunset and Link headers (RFC 9745 / RFC 8594)", () => {
    const headers = deprecationHeaders({
      deprecatedAt: new Date("2026-11-01T00:00:00Z"),
      sunsetAt: new Date("2027-05-01T00:00:00Z"),
      link: "https://kaptionai.com/developers/#deprecations",
    });
    expect(headers.get("deprecation")).toBe("@1793491200");
    expect(headers.get("sunset")).toBe("Sat, 01 May 2027 00:00:00 GMT");
    expect(headers.get("link")).toBe('<https://kaptionai.com/developers/#deprecations>; rel="deprecation"; type="text/html"');
    const response = withDeprecation(new Response("ok", { headers: { Link: "<a>; rel=x" } }), {
      deprecatedAt: new Date(0),
      link: "https://example.test/notes",
    });
    expect(response.headers.get("link")).toContain('rel="deprecation"');
    expect(response.headers.get("link")).toContain("rel=x");
  });
});
