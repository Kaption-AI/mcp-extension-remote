/**
 * mcp.ANOTHER_APP — "Connect another app", driven through createFetchHandler over the REAL OAuth library (FakeKV, no
 * mocks of the provider) with the real sign-in routes: the owner's switch, registration, PKCE, the unknown-site warning
 * data, the tick gate, the redirect checks, the phone allow list, the 90-day rule, the kill switch, the audit log and
 * the rate limits. Known apps (Claude) are checked to go through exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ env: {} as any, cookies: new Map<string, string>() }));

vi.mock("./relay-mcp", () => ({
  RelayMCP: {
    serveSSE: () => ({ fetch: async () => new Response("sse") }),
    serve: () => ({ fetch: async () => new Response("mcp") }),
  },
}));
vi.mock("./relay-room", () => ({ RelayRoom: class RelayRoom {} }));
vi.mock("./deployment-chain", () => ({ DeploymentChainDO: class DeploymentChainDO {} }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: state.env }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
    delete: (name: string) => void state.cookies.delete(name),
    set: (name: string, value: string) => void state.cookies.set(name, value),
  }),
}));

import { createFetchHandler } from "./index";
import { deriveAccountRef, hmacSign, sealState, storeOTP } from "./otp";
import {
  ANOTHER_APP_POLICY_KEY,
  AUDIT_PREFIX,
  DEFAULT_ANOTHER_APP_POLICY,
  hasS256Pkce,
  parseAnotherAppPolicy,
  phoneAllowed,
  registrationVerdict,
  resetAnotherAppPolicyCache,
  unknownSiteHost,
} from "./another-app";
import { activityKey, grantKey, IDLE_LIMIT_SECONDS } from "./connection-lifetime";
import { CONNECT_COOKIE } from "./connect-code";
import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";
import { POST as connectCodePost } from "@/app/authorize/connect-code/route";
import { POST as sendOtpPost } from "@/app/authorize/send-otp/route";
import { POST as verifyOtpPost } from "@/app/authorize/verify-otp/route";
import { POST as reviewerLoginPost } from "@/app/authorize/reviewer-login/route";

const ORIGIN = "https://mcp.kaptionai.com";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OPENBOT_REDIRECT = "https://openbot.example.com/oauth/callback";
const OWNER = "17374202658";
const OWNER_2 = "17373427172";
const STRANGER = "5491112345678";
const VERIFIER = "kaption-test-code-verifier-0123456789-abcdefghijklmnop";
const SECRET = "ephemeral-state-secret";

beforeEach(() => {
  resetAnotherAppPolicyCache();
  state.cookies.clear();
});

function createRelay() {
  const kv = new FakeKV();
  const env = {
    OAUTH_KV: kv,
    JWT_SECRET: "jwt-secret",
    PHONE_REF_SECRET: "phone-ref-secret",
    INTERNAL_API_KEY: "internal-api-key",
    INTERNAL_API_BASE_URL: "https://api.test",
    EPHEMERAL_STATE_SECRET: SECRET,
  } as unknown as Env;
  const pages: string[] = [];
  const routes: Record<string, (request: Request) => Promise<Response>> = {
    "/authorize/connect-code": connectCodePost,
    "/authorize/send-otp": sendOtpPost,
    "/authorize/verify-otp": verifyOtpPost,
    "/authorize/reviewer-login": reviewerLoginPost,
  };
  const handler = createFetchHandler({
    async fetch(request: Request, oauthEnv: Env) {
      state.env = oauthEnv;
      const url = new URL(request.url);
      if (request.method === "POST" && routes[url.pathname]) return routes[url.pathname](request);
      pages.push(request.url);
      return new Response("<html>sign in</html>", { headers: { "Content-Type": "text/html" } });
    },
  } as any);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = async (path: string, init?: RequestInit, ip = "198.51.100.7") => {
    const headers = new Headers(init?.headers);
    headers.set("cf-connecting-ip", ip);
    const response = await handler(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, ctx);
    await Promise.all(pending.splice(0));
    return response;
  };
  return { kv, env, call, pages };
}
type Relay = ReturnType<typeof createRelay>;

async function setPolicy(relay: Relay, value: unknown) {
  await relay.kv.put(ANOTHER_APP_POLICY_KEY, JSON.stringify(value));
  resetAnotherAppPolicyCache();
}

const register = (relay: Relay, uris: string[], name = "OpenBot", ip?: string) =>
  relay.call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none" }),
  }, ip);

async function clientFor(relay: Relay, redirect = OPENBOT_REDIRECT, name = "OpenBot"): Promise<string> {
  const response = await register(relay, [redirect], name);
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function challenge(verifier = VERIFIER): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authorizePath(clientId: string, redirect = OPENBOT_REDIRECT, extra: Record<string, string | null> = {}) {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    state: "st-123",
    code_challenge: await challenge(),
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete params[key];
    else params[key] = value;
  }
  return `/authorize?${new URLSearchParams(params)}`;
}

const HTML = { headers: { accept: "text/html", "accept-language": "en" } };

/** /authorize, then the signed request the sign-in page received. */
async function startSignIn(relay: Relay, clientId: string, redirect = OPENBOT_REDIRECT): Promise<string> {
  const response = await relay.call(await authorizePath(clientId, redirect), HTML);
  expect(response.status).toBe(200);
  const page = new URL(relay.pages.at(-1)!);
  const signed = page.searchParams.get("_oauthReqInfo");
  expect(signed).toBeTruthy();
  return signed!;
}

/** A Kaption code for this phone, as the connector mints it after the WhatsApp handshake (CONNECT_CODE.2). */
async function mintCode(relay: Relay, phone: string, code = "ABCD2345"): Promise<string> {
  await relay.kv.put(`connect-code:${code}`, await sealState({ phone }, 600, SECRET), { expirationTtl: 600 });
  return code;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function exchange(relay: Relay, redirectTo: string, clientId: string, redirect = OPENBOT_REDIRECT) {
  const code = new URL(redirectTo).searchParams.get("code")!;
  return relay.call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: VERIFIER }).toString(),
  });
}

function auditEntries(relay: Relay) {
  return relay.kv.list({ prefix: AUDIT_PREFIX }).then(({ keys }) => keys.map((k) => relay.kv.json<Record<string, unknown>>(k.name)!));
}

describe("mcp.ANOTHER_APP.1 the owner's switch", () => {
  it("mcp.ANOTHER_APP.1 defaults to the owner's two numbers; anything unreadable is the default", () => {
    expect(DEFAULT_ANOTHER_APP_POLICY).toEqual({ mode: "owners", allowPhones: [OWNER, OWNER_2], denyHosts: [] });
    expect(parseAnotherAppPolicy(null)).toEqual(DEFAULT_ANOTHER_APP_POLICY);
    expect(parseAnotherAppPolicy("{not json")).toEqual(DEFAULT_ANOTHER_APP_POLICY);
    expect(parseAnotherAppPolicy({ mode: "everyone" }).mode).toBe("owners");
    expect(parseAnotherAppPolicy({ mode: "off" }).mode).toBe("off");
    expect(parseAnotherAppPolicy({ mode: "on", denyHosts: ["*.Bad.Example", "x", 5] }).denyHosts).toEqual(["bad.example"]);
  });

  it("mcp.ANOTHER_APP.7 a phone completes only when the switch allows it", () => {
    expect(phoneAllowed(OWNER, DEFAULT_ANOTHER_APP_POLICY)).toBe(true);
    expect(phoneAllowed(`+${OWNER_2}`, DEFAULT_ANOTHER_APP_POLICY)).toBe(true);
    expect(phoneAllowed(STRANGER, DEFAULT_ANOTHER_APP_POLICY)).toBe(false);
    expect(phoneAllowed(STRANGER, { ...DEFAULT_ANOTHER_APP_POLICY, mode: "on" })).toBe(true);
    expect(phoneAllowed(OWNER, { ...DEFAULT_ANOTHER_APP_POLICY, mode: "off" })).toBe(false);
  });
});

describe("mcp.ANOTHER_APP.2-4 registration, redirect checks and PKCE", () => {
  it("mcp.ANOTHER_APP.2 an unknown https website is only its real host; never loopback, an IP, a bare name or a look-alike scheme", () => {
    expect(unknownSiteHost(OPENBOT_REDIRECT)).toBe("openbot.example.com");
    expect(unknownSiteHost("https://claude.ai.attacker.example/cb")).toBe("claude.ai.attacker.example");
    expect(unknownSiteHost(CLAUDE_REDIRECT)).toBeNull(); // known: unchanged
    expect(unknownSiteHost("http://localhost:3000/cb")).toBeNull();
    for (const bad of ["http://openbot.example.com/cb", " https://openbot.example.com/cb", "https://203.0.113.9/cb",
      "https://[2001:db8::1]/cb", "https://intranet/cb", "https://user:pw@openbot.example.com/cb",
      "https://openbot.example.com/cb#x", "javascript:alert(1)", "evilapp://cb"]) {
      expect(unknownSiteHost(bad), bad).toBeNull();
    }
  });

  it("mcp.ANOTHER_APP.2 with the default switch an unknown website registers; Claude registers exactly as before", async () => {
    const relay = createRelay();
    expect((await register(relay, [OPENBOT_REDIRECT])).status).toBe(201);
    expect((await register(relay, [CLAUDE_REDIRECT], "Claude")).status).toBe(201);
    for (const bad of [["http://openbot.example.com/cb"], ["https://203.0.113.9/cb"], [" https://openbot.example.com/cb"], ["evilapp://cb"]]) {
      const response = await register(relay, bad);
      expect(response.status, bad[0]).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
  });

  it("mcp.ANOTHER_APP.2 the deny list and mode off refuse unknown websites, never a known app", async () => {
    const relay = createRelay();
    await setPolicy(relay, { mode: "owners", denyHosts: ["example.com", "claude.ai"] });
    expect((await register(relay, [OPENBOT_REDIRECT])).status).toBe(400);
    expect((await register(relay, [CLAUDE_REDIRECT], "Claude")).status).toBe(201);
    expect(registrationVerdict(["https://ok.example.org/cb"], parseAnotherAppPolicy({ denyHosts: ["example.com"] }))).toEqual({ ok: true, unknownHosts: ["ok.example.org"] });
    await setPolicy(relay, { mode: "off" });
    expect((await register(relay, ["https://ok.example.org/cb"])).status).toBe(400);
    expect((await register(relay, [CLAUDE_REDIRECT], "Claude")).status).toBe(201);
  });

  it("mcp.ANOTHER_APP.3 at most 10 unknown-website registrations per address an hour; known apps never count", async () => {
    const relay = createRelay();
    for (let i = 0; i < 10; i += 1) expect((await register(relay, [`https://app${i}.example.org/cb`], "X", "203.0.113.50")).status).toBe(201);
    expect((await register(relay, ["https://app11.example.org/cb"], "X", "203.0.113.50")).status).toBe(429);
    expect((await register(relay, [CLAUDE_REDIRECT], "Claude", "203.0.113.50")).status).toBe(201);
    expect((await register(relay, ["https://app12.example.org/cb"], "X", "203.0.113.51")).status).toBe(201);
  });

  it("mcp.ANOTHER_APP.4 an unknown website needs PKCE S256 to start; Claude's sign-in starts as before", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    expect(hasS256Pkce({ codeChallenge: await challenge(), codeChallengeMethod: "S256" })).toBe(true);
    expect(hasS256Pkce({ codeChallenge: undefined, codeChallengeMethod: undefined })).toBe(false);
    const noPkce = await relay.call(await authorizePath(id, OPENBOT_REDIRECT, { code_challenge: null, code_challenge_method: null }), HTML);
    expect(noPkce.status).toBe(400);
    // The library refuses a public client without PKCE first; S256 is checked again here for every unknown website.
    expect(await noPkce.text()).toContain('data-testid="authorize-error"');
    const plain = await relay.call(await authorizePath(id, OPENBOT_REDIRECT, { code_challenge: "a".repeat(43), code_challenge_method: "plain" }), HTML);
    expect(plain.status).toBe(400);
    expect(relay.pages).toEqual([]);
    await startSignIn(relay, id);
    expect(relay.pages).toHaveLength(1);
    const claude = await clientFor(relay, CLAUDE_REDIRECT, "Claude");
    await startSignIn(relay, claude, CLAUDE_REDIRECT);
  });

  it("mcp.ANOTHER_APP.4 the redirect must be the registered one byte for byte: no other path, query or host (no open redirect)", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    for (const redirect of [
      "https://openbot.example.com/oauth/callback2",
      "https://openbot.example.com/oauth/callback?next=https://evil.example",
      "https://evil.example/oauth/callback",
      "https://OPENBOT.example.com/oauth/callback",
      "https://openbot.example.com/oauth/callback/",
    ]) {
      const response = await relay.call(await authorizePath(id, redirect), HTML);
      expect(response.status, redirect).toBe(400);
    }
    expect(relay.pages).toEqual([]);
  });

  it("mcp.ANOTHER_APP.9 with the switch off, or the host denied after registering, the sign-in does not start", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    await setPolicy(relay, { mode: "off" });
    expect((await relay.call(await authorizePath(id), HTML)).status).toBe(400);
    await setPolicy(relay, { mode: "on", denyHosts: ["openbot.example.com"] });
    expect((await relay.call(await authorizePath(id), HTML)).status).toBe(400);
    expect(relay.pages).toEqual([]);
  });
});

describe("mcp.ANOTHER_APP.5-8 the sign-in: the tick, the phone, the signed request, the 90-day rule", () => {
  it("mcp.ANOTHER_APP.6 without the tick a Kaption code is refused (trust_required) and not spent", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    const code = await mintCode(relay, OWNER);
    for (const trustedSite of [undefined, false, "true", 1]) {
      const response = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code, trustedSite }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "trust_required", errorKey: "err.trust_required" });
    }
    expect(await relay.kv.get(`connect-code:${code}`)).not.toBeNull();
  });

  it("mcp.ANOTHER_APP.5-8 an owner with the tick connects: the code goes only to the registered redirect, PKCE is checked, the connection is marked and lasts While I use it", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    const code = await mintCode(relay, OWNER);
    const response = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code, trustedSite: true, connectionLifetime: "until-revoked" }));
    expect(response.status).toBe(200);
    const { redirectTo } = (await response.json()) as { redirectTo: string };
    const back = new URL(redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(OPENBOT_REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-123");
    expect(await relay.kv.get(`connect-code:${code}`)).toBeNull();

    // PKCE S256: a wrong verifier gets nothing, the right one the tokens.
    const wrong = await relay.call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: OPENBOT_REDIRECT, client_id: id, code_verifier: `${VERIFIER}-wrong` }).toString(),
    });
    expect(wrong.status).toBe(400);
    const signedAgain = await startSignIn(relay, id);
    const code2 = await mintCode(relay, OWNER, "WXYZ2345");
    const again = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signedAgain, code: code2, trustedSite: true }));
    const tokens = await exchange(relay, ((await again.json()) as { redirectTo: string }).redirectTo, id);
    expect(tokens.status).toBe(200);

    const accountRef = (await deriveAccountRef(OWNER, "phone-ref-secret"))!;
    const { keys } = await relay.kv.list({ prefix: `grant:${accountRef}:` });
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const grant = relay.kv.json<{ metadata: Record<string, unknown> }>(key.name)!;
      expect(grant.metadata).toMatchObject({ anotherApp: true, destination: "openbot.example.com", lifetime: "inactive-90d" });
    }
  });

  it("mcp.ANOTHER_APP.6 a changed signed request is refused: the approval is bound to the whole request", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    const [payload] = signed.split(".");
    const request = JSON.parse(atob(payload));
    const forged = btoa(JSON.stringify({ ...request, redirectUri: "https://evil.example/cb", state: "other" }));
    const tampered = `${forged}.${signed.split(".").slice(1).join(".")}`;
    const code = await mintCode(relay, OWNER);
    const response = await relay.call("/authorize/connect-code", json({ oauthReqInfo: tampered, code, trustedSite: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_oauth_state" });
    expect(await relay.kv.get(`connect-code:${code}`)).not.toBeNull();
    // Signed with our key but for a redirect the client never registered: the library still refuses it.
    const unregistered = await hmacSign(btoa(JSON.stringify({ ...request, redirectUri: "https://evil.example/cb" })), "internal-api-key");
    const refused = await relay.call("/authorize/connect-code", json({ oauthReqInfo: unregistered, code, trustedSite: true }));
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("mcp.ANOTHER_APP.7 a phone outside the switch is refused before its code is spent; mode on lets everyone in", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    const code = await mintCode(relay, STRANGER);
    const refused = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code, trustedSite: true }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "another_app_unavailable", errorKey: "err.another_app_unavailable" });
    expect(await relay.kv.get(`connect-code:${code}`)).not.toBeNull();
    await setPolicy(relay, { mode: "on" });
    const allowed = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code, trustedSite: true }));
    expect(allowed.status).toBe(200);
  });

  it("mcp.ANOTHER_APP.6-7 a known app needs no tick and keeps its lifetime choice (unchanged)", async () => {
    const relay = createRelay();
    const id = await clientFor(relay, CLAUDE_REDIRECT, "Claude");
    const signed = await startSignIn(relay, id, CLAUDE_REDIRECT);
    const code = await mintCode(relay, STRANGER);
    const response = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code, connectionLifetime: "until-revoked" }));
    expect(response.status).toBe(200);
    expect(new URL(((await response.json()) as { redirectTo: string }).redirectTo).origin).toBe("https://claude.ai");
    const accountRef = (await deriveAccountRef(STRANGER, "phone-ref-secret"))!;
    const { keys } = await relay.kv.list({ prefix: `grant:${accountRef}:` });
    const grant = relay.kv.json<{ metadata: Record<string, unknown> }>(keys[0].name)!;
    expect(grant.metadata).toEqual({ label: `WhatsApp ${accountRef.slice(0, 13)}`, lifetime: "until-revoked" });
    expect(await auditEntries(relay)).toEqual([]);
  });

  it("mcp.ANOTHER_APP.6-7 the phone + WhatsApp code: send needs the tick and an allowed phone; verify checks the switch again", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const noTick = await relay.call("/authorize/send-otp", json({ phone: OWNER, oauthReqInfo: signed }));
      expect(noTick.status).toBe(400);
      expect(await noTick.json()).toMatchObject({ code: "trust_required" });
      const stranger = await relay.call("/authorize/send-otp", json({ phone: STRANGER, oauthReqInfo: signed, trustedSite: true }));
      expect(stranger.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();

      const sent = await relay.call("/authorize/send-otp", json({ phone: OWNER, oauthReqInfo: signed, trustedSite: true }));
      expect(sent.status).toBe(200);
      const { verifyTicket } = (await sent.json()) as { verifyTicket: string };
      const accountRef = (await deriveAccountRef(OWNER, "phone-ref-secret"))!;

      // The owner turns it off between the two steps: the verification is refused.
      await setPolicy(relay, { mode: "off" });
      await storeOTP(relay.kv as unknown as KVNamespace, accountRef, "123456");
      const off = await relay.call("/authorize/verify-otp", json({ verifyTicket, code: "123456" }));
      expect(off.status).toBe(403);

      resetAnotherAppPolicyCache();
      await relay.kv.delete(ANOTHER_APP_POLICY_KEY);
      const ok = await relay.call("/authorize/verify-otp", json({ verifyTicket, code: "123456", connectionLifetime: "fixed-1y" }));
      expect(ok.status).toBe(200);
      const tokens = await exchange(relay, ((await ok.json()) as { redirectTo: string }).redirectTo, id);
      expect(tokens.status).toBe(200);
      const { keys } = await relay.kv.list({ prefix: `grant:${accountRef}:` });
      expect(relay.kv.json<{ metadata: Record<string, unknown> }>(keys[0].name)!.metadata).toMatchObject({ anotherApp: true, lifetime: "inactive-90d" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("mcp.ANOTHER_APP.13 the reviewer sign-in refuses unknown websites", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pw")));
    Object.assign(relay.env, { OPENAI_REVIEW_PHONE: OWNER, OPENAI_REVIEW_PASSWORD_SHA256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") });
    const response = await relay.call("/authorize/reviewer-login", json({ phone: OWNER, password: "pw", oauthReqInfo: signed }));
    expect(response.status).toBe(403);
  });

  it("mcp.ANOTHER_APP.11 at most 5 new unknown-website connections per account a day", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    for (let i = 0; i < 6; i += 1) {
      const signed = await startSignIn(relay, id);
      const code = await mintCode(relay, OWNER, `ABCD${"23456789"[i]}${"23456789"[i]}${"23456789"[i]}${"23456789"[i]}`);
      const response = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code, trustedSite: true }));
      expect(response.status, `connection ${i + 1}`).toBe(i < 5 ? 200 : 429);
    }
  });
});

describe("mcp.ANOTHER_APP.8-10 the 90-day rule, the kill switch and the audit log", () => {
  async function connected(relay: Relay) {
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    const code = await mintCode(relay, OWNER);
    const response = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code, trustedSite: true, connectionLifetime: "until-revoked" }));
    const tokens = (await (await exchange(relay, ((await response.json()) as { redirectTo: string }).redirectTo, id)).json()) as { refresh_token: string };
    const [userId, grantId] = tokens.refresh_token.split(":");
    return { id, refresh: tokens.refresh_token, ref: { userId, grantId } };
  }
  const refresh = (relay: Relay, id: string, token: string) =>
    relay.call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: id }).toString(),
    });

  it("mcp.ANOTHER_APP.8 a refresh after 90 days without use is refused and the connection revoked, whatever was picked", async () => {
    const relay = createRelay();
    const { id, refresh: token, ref } = await connected(relay);
    const idle = Math.floor(Date.now() / 1000) - IDLE_LIMIT_SECONDS - 60;
    await relay.kv.put(activityKey(ref), String(idle));
    const grant = relay.kv.json<Record<string, unknown>>(grantKey(ref))!;
    await relay.kv.put(grantKey(ref), JSON.stringify({ ...grant, createdAt: idle, metadata: { ...(grant.metadata as object), lifetime: "until-revoked" } }));
    const response = await refresh(relay, id, token);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(await relay.kv.get(grantKey(ref))).toBeNull();
  });

  it("mcp.ANOTHER_APP.9 the kill switch holds a connection without revoking it; turning it back on restores it", async () => {
    const relay = createRelay();
    const { id, refresh: token, ref } = await connected(relay);
    await setPolicy(relay, { mode: "off" });
    const held = await refresh(relay, id, token);
    expect(held.status).toBe(400);
    expect(await relay.kv.get(grantKey(ref))).not.toBeNull();
    await setPolicy(relay, { mode: "owners", denyHosts: ["example.com"] });
    expect((await refresh(relay, id, token)).status).toBe(400);
    await setPolicy(relay, { mode: "owners" });
    expect((await refresh(relay, id, token)).status).toBe(200);
  });

  it("mcp.ANOTHER_APP.10 registration, sign-in start, approval and refusals are audited; never a phone or a code", async () => {
    const relay = createRelay();
    await connected(relay);
    const id = await clientFor(relay, "https://other.example.org/cb");
    const signed = await startSignIn(relay, id, "https://other.example.org/cb");
    await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, code: await mintCode(relay, STRANGER, "QRST2345"), trustedSite: true }));
    const entries = await auditEntries(relay);
    const events = entries.map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["registered", "signin_started", "approved", "refused"]));
    expect(entries.find((e) => e.event === "approved")).toMatchObject({ host: "openbot.example.com" });
    const text = JSON.stringify(entries);
    for (const secret of [OWNER, STRANGER, "ABCD2345", "QRST2345"]) expect(text).not.toContain(secret);
    const { keys } = await relay.kv.list({ prefix: AUDIT_PREFIX });
    expect(relay.kv.expirationOf(keys[0].name)).toBeGreaterThan(Date.now() / 1000 + 170 * 24 * 3600);
  });

  it("mcp.ANOTHER_APP.4 a code remembered on this browser by /connect works with the tick too", async () => {
    const relay = createRelay();
    const id = await clientFor(relay);
    const signed = await startSignIn(relay, id);
    state.cookies.set(CONNECT_COOKIE, await mintCode(relay, OWNER_2));
    const response = await relay.call("/authorize/connect-code", json({ oauthReqInfo: signed, remembered: true, trustedSite: true }));
    expect(response.status).toBe(200);
  });
});

describe("mcp.ANOTHER_APP — Claude and ChatGPT see nothing new", () => {
  it("mcp.ANOTHER_APP the discovery documents are byte-identical to production's before this change (2026-11-12)", async () => {
    const prod = (await import("./test-support/prod-discovery-2026-11-12.json")).default as Record<string, string>;
    const relay = createRelay();
    for (const [path, body] of Object.entries(prod)) {
      const response = await relay.call(`/.well-known/${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(body);
    }
  });
});
