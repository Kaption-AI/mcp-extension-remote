/**
 * mcp.ANY_CLIENT — any MCP app signs in with "Sign in with Kaption on this computer", end to end over the REAL OAuth
 * library (FakeKV, the relay's own fetch handler and the sign-in routes): registration under the owner's policy, the
 * approval bound to the client, redirect, PKCE and browser, the WhatsApp handshake as the only proof, single use, the
 * audit and Connected apps. Fictional 555 numbers and example.org hosts only.
 */
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKV } from "./test-support/fake-kv";
import type { Env } from "./types";

vi.mock("./relay-mcp", () => ({
  RelayMCP: {
    serveSSE: () => ({ fetch: async () => new Response("sse") }),
    serve: () => ({ fetch: async () => new Response("mcp") }),
  },
}));
vi.mock("./relay-room", () => ({ RelayRoom: class RelayRoom {} }));
vi.mock("./deployment-chain", () => ({ DeploymentChainDO: class DeploymentChainDO {} }));

const state = vi.hoisted(() => ({ env: {} as any, jar: new Map<string, string>() }));
/** mcp.ANY_CLIENT.16 — whether /authorize is opened in a tester's browser (the tester cookie). */
const testerBrowser = { on: false };
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: state.env }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string) => { state.jar.set(name, value); },
    delete: (name: string) => { state.jar.delete(name); },
  }),
}));

import { buildOAuthOptions, createFetchHandler } from "./index";
import { POST as approvalStart } from "@/app/authorize/approval/start/route";
import { POST as approvalStatus } from "@/app/authorize/approval/status/route";
import { POST as approvalComplete } from "@/app/authorize/approval/complete/route";
import { POST as connectCode } from "@/app/authorize/connect-code/route";
import { POST as sendOtp } from "@/app/authorize/send-otp/route";
import { readApprovalAudit } from "./approval";
import { deriveAccountRef } from "./otp";
import {
  REDIRECT_POLICY_KEY,
  classifyWithPolicy,
  parseRedirectPolicy,
  resetRedirectPolicyCache,
  DEFAULT_ALLOW_PHONES,
  DEFAULT_REDIRECT_POLICY,
  TESTER_COOKIE,
} from "./redirect-policy";

const ORIGIN = "https://mcp.kaptionai.com";
const ON = parseRedirectPolicy({ mode: "on" });
const API = "https://api.example.test";
const N8N_REDIRECT = "https://n8n.example.org/rest/oauth2-credential/callback";
const LOOPBACK_REDIRECT = "http://127.0.0.1:6274/oauth/callback";
const JWT_SECRET = "jwt-secret";
const PHONE = "15555550123";
const OTHER = "15555550199";
const VERIFIER = "kaption-test-code-verifier-0123456789-abcdefghijklmnop";

// What rest-api's auth v3 answers (the handshake's proof).
const v3 = vi.hoisted(() => ({ status: { confirmed: false, reason: "pending" } as Record<string, unknown>, sessions: 0 }));

beforeEach(() => {
  state.jar.clear();
  testerBrowser.on = false;
  v3.status = { confirmed: false, reason: "pending" };
  v3.sessions = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${API}/api/v5/auth/v3/session`) {
      v3.sessions += 1;
      return Response.json({ sessionToken: `kv3_session_${v3.sessions}`, assurance: "unverified" });
    }
    if (url === `${API}/api/v5/auth/v3/status`) return Response.json(v3.status);
    return new Response("unexpected", { status: 599 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** The flows below run with the switch "on" (for everyone); `null` stores no policy (the default, "allowlist"). */
function createRelay(policy: Record<string, unknown> | null = { mode: "on" }) {
  resetRedirectPolicyCache();
  const kv = new FakeKV();
  if (policy) void kv.put(REDIRECT_POLICY_KEY, JSON.stringify(policy));
  const env = {
    OAUTH_KV: kv,
    JWT_SECRET,
    PHONE_REF_SECRET: "phone-ref-secret",
    INTERNAL_API_KEY: "internal-api-key",
    EPHEMERAL_STATE_SECRET: "e".repeat(32),
    INTERNAL_API_BASE_URL: API,
  } as unknown as Env;
  const pages: Request[] = [];
  const next = vi.fn(async (request: Request) => {
    pages.push(request);
    return new Response("<html>sign in</html>", { headers: { "Content-Type": "text/html" } });
  });
  const handler = createFetchHandler({ fetch: next });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = (path: string, init?: RequestInit) => handler(new Request(`${ORIGIN}${path}`, init), env, ctx);
  const helpers = getOAuthApi(buildOAuthOptions(ORIGIN, { fetch: next }, kv as unknown as KVNamespace), env);
  (env as any).OAUTH_PROVIDER = helpers;
  state.env = env;
  return { kv, env, call, pages, helpers };
}
type Relay = ReturnType<typeof createRelay>;

async function register(relay: Relay, redirect: string, name: string) {
  return relay.call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
}

async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Registers the app and opens /authorize like the app would; returns the signed request the sign-in page got. */
async function signInPage(relay: Relay, redirect = N8N_REDIRECT, name = "n8n", verifier: string | null = VERIFIER) {
  const reg = await register(relay, redirect, name);
  expect(reg.status).toBe(201);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  return { clientId, ...(await authorize(relay, clientId, redirect, verifier)) };
}

async function authorize(relay: Relay, clientId: string, redirect: string, verifier: string | null = VERIFIER, state = "st") {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state });
  if (verifier) {
    q.set("code_challenge", await challenge(verifier));
    q.set("code_challenge_method", "S256");
  }
  const cookie = testerBrowser.on ? `${TESTER_COOKIE}=1` : "";
  const response = await relay.call(`/authorize?${q}`, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
  expect(response.status).toBe(200);
  const page = relay.pages.at(-1)!;
  return { oauthReqInfo: new URL(page.url).searchParams.get("_oauthReqInfo")! };
}

const post = (path: string, body: unknown, ip = "192.0.2.10", headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify(body),
  });

const jwtFor = (phone: string) =>
  new SignJWT({ phoneNumber: phone }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(JWT_SECRET));

async function ext(relay: Relay, action: string, requestId: string, phone = PHONE) {
  const response = await relay.call("/ext/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwtFor(phone)}` },
    body: JSON.stringify({ action, requestId }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function startApproval(oauthReqInfo: string, ip?: string) {
  const response = await approvalStart(post("/authorize/approval/start", { oauthReqInfo }, ip));
  return { status: response.status, body: (await response.json()) as any };
}

const pageStatus = async (requestId: string) => ((await (await approvalStatus(post("/authorize/approval/status", { requestId }))).json()) as any).status;
const complete = async (requestId: string, oauthReqInfo: string) => {
  const response = await approvalComplete(post("/authorize/approval/complete", { requestId, oauthReqInfo, connectionLifetime: "inactive-90d" }));
  return { status: response.status, body: (await response.json()) as any };
};

/** Allow in WhatsApp: the handshake starts, the bot proves the phone. */
async function allow(relay: Relay, requestId: string, phone = PHONE) {
  const started = await ext(relay, "start", requestId, phone);
  expect(started.body).toMatchObject({ ok: true, sessionToken: expect.stringMatching(/^kv3_/) });
  v3.status = { confirmed: true, proven: true };
  return ext(relay, "status", requestId, phone);
}

describe("mcp.ANY_CLIENT.1-2 registration under the owner's policy", () => {
  it("mcp.ANY_CLIENT.1 accepts an https app on any host, still refuses http, IPs, dotless hosts, whitespace and odd schemes", async () => {
    const relay = createRelay();
    for (const ok of [N8N_REDIRECT, "https://agents.example.org:8443/cb", "https://claude.ai.attacker.example/cb"]) {
      expect((await register(relay, ok, "Probe")).status, ok).toBe(201);
    }
    for (const bad of [
      "http://n8n.example.org/cb",
      "https://203.0.113.7/cb",
      "https://[2001:db8::1]/cb",
      "https://intranet/cb",
      " https://n8n.example.org/cb",
      "https://user:pw@n8n.example.org/cb",
      "https://n8n.example.org/cb#x",
      "evilapp://callback",
      "javascript:alert(1)",
    ]) {
      const response = await register(relay, bad, "Probe");
      expect(response.status, bad).toBe(400);
      expect(((await response.json()) as { error: string }).error, bad).toMatch(/^invalid_(redirect_uri|client_metadata)$/);
    }
  });

  it("mcp.ANY_CLIENT.1 a look-alike of a known app is an unknown website, never a known one", () => {
    expect(classifyWithPolicy("https://claude.ai.attacker.example/cb", ON)).toBe("unknown_web");
    expect(classifyWithPolicy("https://evilclaude.ai/cb", ON)).toBe("unknown_web");
    expect(classifyWithPolicy("https://claude.ai/api/mcp/auth_callback")).toBe("web");
    expect(classifyWithPolicy("http://localhost.attacker.example/cb")).toBeNull();
    expect(classifyWithPolicy(LOOPBACK_REDIRECT)).toBe("loopback");
    // mcp.ANY_CLIENT.16 — by default (allowlist, no preview hosts) a look-alike is refused, as before any-client.
    expect(classifyWithPolicy("https://claude.ai.attacker.example/cb")).toBeNull();
  });

  it("mcp.ANY_CLIENT.2 known-only refuses unknown websites; the deny list refuses even a known app; allowHosts makes one known", async () => {
    let relay = createRelay({ mode: "known-only" });
    expect((await register(relay, N8N_REDIRECT, "n8n")).status).toBe(400);
    expect((await register(relay, LOOPBACK_REDIRECT, "Inspector")).status).toBe(201);

    relay = createRelay({ mode: "on", denyHosts: ["claude.ai", "bad.example.org"] });
    expect((await register(relay, "https://claude.ai/api/mcp/auth_callback", "Claude")).status).toBe(400);
    expect((await register(relay, "https://x.bad.example.org/cb", "X")).status).toBe(400);
    expect((await register(relay, N8N_REDIRECT, "n8n")).status).toBe(201);

    const policy = parseRedirectPolicy(JSON.stringify({ allowHosts: ["*.example.org"] }));
    expect(classifyWithPolicy(N8N_REDIRECT, policy)).toBe("web");
  });

  it("mcp.ANY_CLIENT.2 an unreadable policy is the default", () => {
    expect(parseRedirectPolicy("{not json")).toEqual(DEFAULT_REDIRECT_POLICY);
    expect(parseRedirectPolicy(null)).toEqual(DEFAULT_REDIRECT_POLICY);
    // mcp.ANY_CLIENT.16 — an unknown mode is the default, "allowlist" (never "on").
    expect(parseRedirectPolicy({ mode: "everything", denyHosts: ["ok.example", 5, "nodot"] })).toEqual({
      mode: "allowlist", allowHosts: [], denyHosts: ["ok.example"], allowPhones: DEFAULT_ALLOW_PHONES, previewHosts: [],
    });
    expect(parseRedirectPolicy({ mode: "known-only" }).mode).toBe("off");
    expect(parseRedirectPolicy({ mode: "on", allowPhones: ["+1 (555) 555-0123", 15555550199, "x"] }).allowPhones).toEqual(["15555550123", "15555550199"]);
  });

  it("mcp.ANY_CLIENT.2 a host denied after registration can no longer start a sign-in", async () => {
    const relay = createRelay();
    const reg = await register(relay, N8N_REDIRECT, "n8n");
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    await relay.kv.put(REDIRECT_POLICY_KEY, JSON.stringify({ mode: "on", denyHosts: ["example.org"] }));
    resetRedirectPolicyCache();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: N8N_REDIRECT, state: "s", code_challenge: await challenge(VERIFIER), code_challenge_method: "S256" });
    const response = await relay.call(`/authorize?${q}`, { headers: { accept: "text/html" } });
    expect(response.status).toBe(400);
  });
});

describe("mcp.ANY_CLIENT.3 an unknown website is completed only by the approval", () => {
  it("the Kaption code and the WhatsApp code refuse it (403 approval_required)", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay);
    const code = await connectCode(post("/authorize/connect-code", { oauthReqInfo, code: "ABCD-2345" }));
    expect(code.status).toBe(403);
    expect(await code.json()).toMatchObject({ code: "approval_required" });
    const otp = await sendOtp(post("/authorize/send-otp", { oauthReqInfo, phone: `+${PHONE}` }));
    expect(otp.status).toBe(403);
    expect(await otp.json()).toMatchObject({ code: "approval_required" });
  });
});

describe("mcp.ANY_CLIENT.5-13 Sign in with Kaption on this computer", () => {
  it("mcp.ANY_CLIENT.5, .8, .9, .11, .13 an n8n on its own website: approved in Kaption, proven by WhatsApp, connected once", async () => {
    const relay = createRelay();
    const { clientId, oauthReqInfo } = await signInPage(relay);

    const started = await startApproval(oauthReqInfo);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/), kind: "unknown_web" });
    const requestId: string = started.body.requestId;
    // mcp.ANY_CLIENT.5 — the browser holds a secret; KV only its hash.
    const [[cookieName, secret]] = [...state.jar.entries()];
    expect(cookieName).toBe(`kaption_approval_${requestId.slice(0, 16)}`);
    expect(JSON.stringify([...(relay.kv as any).entries.values()])).not.toContain(secret);

    // mcp.ANY_CLIENT.8 — the extension shows what the relay knows, not what the page said.
    const details = await ext(relay, "details", requestId);
    expect(details.body).toMatchObject({ ok: true, status: "pending", appName: "n8n", kind: "unknown_web", destination: "n8n.example.org", detail: null });

    // Not approved yet: nothing to complete.
    expect(await pageStatus(requestId)).toBe("pending");
    expect((await complete(requestId, oauthReqInfo)).status).toBe(409);

    // mcp.ANY_CLIENT.9 — the JWT alone approves nothing: the handshake is pending, then accepted but not proven.
    expect((await ext(relay, "start", requestId)).body.ok).toBe(true);
    expect((await ext(relay, "status", requestId)).body.status).toBe("pending");
    v3.status = { confirmed: true, proven: false };
    expect((await ext(relay, "status", requestId)).body.status).toBe("unproven");
    expect(await pageStatus(requestId)).toBe("pending");

    // Proven: approved.
    expect((await allow(relay, requestId)).body.status).toBe("approved");
    expect(await pageStatus(requestId)).toBe("approved");

    // mcp.ANY_CLIENT.11 — completes once, to the app's own redirect.
    const done = await complete(requestId, oauthReqInfo);
    expect(done.status).toBe(200);
    const redirect = new URL(done.body.redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(N8N_REDIRECT);
    expect(redirect.searchParams.get("state")).toBe("st");
    expect((await complete(requestId, oauthReqInfo)).status).toBe(400);

    // The code works only with the PKCE verifier (it is the app's own).
    const exchange = (verifier: string) => relay.call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, redirect_uri: N8N_REDIRECT, client_id: clientId, code_verifier: verifier }).toString(),
    });
    expect((await exchange("a-different-verifier-0123456789-abcdefghijklmnopqrs")).status).toBe(400);

    // mcp.ANY_CLIENT.13 — the audit and Connected apps.
    const accountRef = (await deriveAccountRef(PHONE, "phone-ref-secret"))!;
    const audit = await readApprovalAudit(relay.kv as unknown as KVNamespace, accountRef);
    expect(audit.map((e) => e.outcome)).toEqual(["connected", "approved"]);
    expect(audit[0]).toMatchObject({ appName: "n8n", clientId, destination: "n8n.example.org", kind: "unknown_web" });
    const list = await relay.call("/ext/connections", { headers: { Authorization: `Bearer ${await jwtFor(PHONE)}` } });
    const { connections } = (await list.json()) as { connections: Array<{ appName: string; destination?: string }> };
    expect(connections).toEqual([expect.objectContaining({ appName: "n8n", destination: "n8n.example.org" })]);
  });

  it("mcp.ANY_CLIENT.8 a loopback app (the MCP Inspector) shows as an app on this computer with its port", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay, LOOPBACK_REDIRECT, "MCP Inspector");
    const { body } = await startApproval(oauthReqInfo);
    expect((await ext(relay, "details", body.requestId)).body).toMatchObject({ kind: "loopback", destination: "local", detail: "6274" });
    expect((await allow(relay, body.requestId)).body.status).toBe("approved");
    const done = await complete(body.requestId, oauthReqInfo);
    expect(new URL(done.body.redirectTo).origin).toBe("http://127.0.0.1:6274");
  });

  it("mcp.ANY_CLIENT.5 an app outside the known list must use PKCE S256 (the library refuses none and plain before the page)", async () => {
    const relay = createRelay();
    const reg = await register(relay, LOOPBACK_REDIRECT, "No PKCE");
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    for (const extra of [{} as Record<string, string>, { code_challenge: "plain-challenge-0123456789-abcdefghijklmnopqrstuvwxyz", code_challenge_method: "plain" }]) {
      const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, state: "s", ...extra });
      expect((await relay.call(`/authorize?${q}`, { headers: { accept: "text/html" } })).status).toBe(400);
    }
  });

  it("mcp.ANY_CLIENT.5 at most 10 approval requests per address in 10 minutes", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay);
    for (let i = 0; i < 10; i++) expect((await startApproval(oauthReqInfo, "198.51.100.1")).status).toBe(200);
    expect((await startApproval(oauthReqInfo, "198.51.100.1")).status).toBe(429);
    expect((await startApproval(oauthReqInfo, "198.51.100.2")).status).toBe(200);
  });

  it("mcp.ANY_CLIENT.5 a tampered sign-in request is refused", async () => {
    createRelay();
    expect((await startApproval("eyJmYWtlIjoxfQ.bad")).status).toBe(400);
  });

  it("mcp.ANY_CLIENT.11-12 another browser (no cookie) learns nothing and can't complete", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay);
    const { body } = await startApproval(oauthReqInfo);
    await allow(relay, body.requestId);
    const saved = new Map(state.jar);
    state.jar.clear();
    expect(await pageStatus(body.requestId)).toBe("expired");
    expect((await complete(body.requestId, oauthReqInfo)).body).toMatchObject({ code: "approval_expired" });
    state.jar.set("kaption_approval_" + body.requestId.slice(0, 16), "x".repeat(43));
    expect((await complete(body.requestId, oauthReqInfo)).status).toBe(400);
    for (const [k, v] of saved) state.jar.set(k, v);
    expect((await complete(body.requestId, oauthReqInfo)).status).toBe(200);
  });

  it("mcp.ANY_CLIENT.11 an approval is bound to its client, redirect and PKCE challenge", async () => {
    const relay = createRelay();
    const { clientId, oauthReqInfo } = await signInPage(relay);
    const { body } = await startApproval(oauthReqInfo);
    await allow(relay, body.requestId);
    // The same app's sign-in with another PKCE challenge (another request) can't spend this approval.
    const other = await authorize(relay, clientId, N8N_REDIRECT, "another-verifier-0123456789-abcdefghijklmnopqrstuv");
    expect((await complete(body.requestId, other.oauthReqInfo)).body).toMatchObject({ code: "approval_mismatch" });
    // Nor another app's.
    const stranger = await signInPage(relay, "https://evil.example.org/cb", "n8n");
    expect((await complete(body.requestId, stranger.oauthReqInfo)).body).toMatchObject({ code: "approval_mismatch" });
    expect((await complete(body.requestId, oauthReqInfo)).status).toBe(200);
  });

  it("mcp.ANY_CLIENT.9 once one phone started the handshake, another can't see, start, poll or deny it", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay);
    const { body } = await startApproval(oauthReqInfo);
    await ext(relay, "start", body.requestId, PHONE);
    expect((await ext(relay, "details", body.requestId, OTHER)).body).toMatchObject({ ok: false, error: "expired" });
    expect((await ext(relay, "start", body.requestId, OTHER)).body).toMatchObject({ ok: false, error: "other_account" });
    v3.status = { confirmed: true, proven: true };
    expect((await ext(relay, "status", body.requestId, OTHER)).body.status).toBe("expired");
    expect((await ext(relay, "deny", body.requestId, OTHER)).body.ok).toBe(false);
    expect(await pageStatus(body.requestId)).toBe("pending");
  });

  it("mcp.ANY_CLIENT.9 the extension's endpoints need the Kaption JWT and a known action", async () => {
    const relay = createRelay();
    const anonymous = await relay.call("/ext/approval", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(anonymous.status).toBe(401);
    expect((await ext(relay, "approve-now", "x".repeat(32))).status).toBe(400);
  });

  it("mcp.ANY_CLIENT.9 handshakes count against the phone's 10 an hour", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay);
    const { body } = await startApproval(oauthReqInfo);
    for (let i = 0; i < 10; i++) expect((await ext(relay, "start", body.requestId)).status).toBe(200);
    expect((await ext(relay, "start", body.requestId)).status).toBe(429);
  });

  it("mcp.ANY_CLIENT.10, .13 Deny: the page hears it, nothing completes, the audit keeps it", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay);
    const { body } = await startApproval(oauthReqInfo);
    expect((await ext(relay, "deny", body.requestId)).body.ok).toBe(true);
    expect(await pageStatus(body.requestId)).toBe("denied");
    expect((await ext(relay, "details", body.requestId)).body.ok).toBe(false);
    expect((await complete(body.requestId, oauthReqInfo)).body).toMatchObject({ code: "approval_denied" });
    const accountRef = (await deriveAccountRef(PHONE, "phone-ref-secret"))!;
    expect((await readApprovalAudit(relay.kv as unknown as KVNamespace, accountRef)).map((e) => e.outcome)).toEqual(["denied"]);
  });

  it("mcp.ANY_CLIENT.5 the request expires after 5 minutes", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay);
    const { body } = await startApproval(oauthReqInfo);
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
    try {
      expect(await pageStatus(body.requestId)).toBe("expired");
      expect((await ext(relay, "details", body.requestId)).body.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("mcp.ANY_CLIENT.16 the owner's switch: off by default except the owner's test phones", () => {
  const OWNER = "17373427172";
  const OWNER_2 = "17374202658";
  const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

  it("mcp.ANY_CLIENT.16 with no stored policy, registration and Claude's sign-in are as before any-client", async () => {
    const relay = createRelay(null);
    const refused = await register(relay, N8N_REDIRECT, "n8n");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error_description: string }).error_description).toBe(
      "This redirect URI is not accepted. Kaption connects to known AI apps (Claude, ChatGPT, Cursor, …) and to apps "
      + "on your own computer (http://localhost or http://127.0.0.1 on any port). To connect another app, write to hello@kaptionai.com.",
    );
    const { oauthReqInfo } = await signInPage(relay, CLAUDE, "Claude");
    expect(oauthReqInfo).toBeTruthy();
    expect(DEFAULT_REDIRECT_POLICY).toMatchObject({ mode: "allowlist", allowPhones: [OWNER, OWNER_2], previewHosts: [] });
  });

  it("mcp.ANY_CLIENT.16 by default a browser that hasn't opted in can't start an approval, and a random phone gets nothing", async () => {
    const relay = createRelay(null);
    const { oauthReqInfo } = await signInPage(relay, LOOPBACK_REDIRECT, "MCP Inspector");
    const started = await startApproval(oauthReqInfo);
    expect(started.status).toBe(403);
    expect(started.body).toMatchObject({ code: "approval_disabled" });
    const random = await ext(relay, "details", "x".repeat(32), PHONE);
    expect(random).toMatchObject({ status: 403, body: { ok: false, error: "not_enabled" } });
    // The owner's phones reach the endpoint (this id simply doesn't exist).
    expect(await ext(relay, "details", "x".repeat(32), OWNER)).toMatchObject({ status: 200, body: { ok: false, error: "expired" } });
    expect((await ext(relay, "details", "x".repeat(32), OWNER_2)).status).toBe(200);
  });

  it("mcp.ANY_CLIENT.16 allowlist: a tester's browser on a preview host completes for the owner's phone only", async () => {
    const relay = createRelay({ mode: "allowlist", previewHosts: ["example.org"] });
    // Without the tester cookie, /authorize refuses the unknown website as before.
    const reg = await register(relay, N8N_REDIRECT, "n8n");
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: N8N_REDIRECT, state: "s", code_challenge: await challenge(VERIFIER), code_challenge_method: "S256" });
    expect((await relay.call(`/authorize?${q}`, { headers: { accept: "text/html" } })).status).toBe(400);
    // Not a preview host: refused at registration.
    expect((await register(relay, "https://agents.other.example/cb", "x")).status).toBe(400);

    testerBrowser.on = true;
    state.jar.set(TESTER_COOKIE, "1");
    const { oauthReqInfo } = await authorize(relay, clientId, N8N_REDIRECT);
    const { body } = await startApproval(oauthReqInfo);
    expect(body.kind).toBe("unknown_web");
    // A random phone can't see or start it.
    expect((await ext(relay, "start", body.requestId, PHONE)).body).toMatchObject({ ok: false, error: "not_enabled" });
    expect((await allow(relay, body.requestId, OWNER)).body.status).toBe("approved");
    expect((await complete(body.requestId, oauthReqInfo)).status).toBe(200);
  });

  it("mcp.ANY_CLIENT.16 off (and the older known-only): nobody, the owner included, even in a tester's browser", async () => {
    for (const mode of ["off", "known-only"]) {
      const relay = createRelay({ mode });
      state.jar.set(TESTER_COOKIE, "1");
      testerBrowser.on = true;
      expect((await register(relay, N8N_REDIRECT, "n8n")).status).toBe(400);
      const { oauthReqInfo } = await signInPage(relay, LOOPBACK_REDIRECT, "MCP Inspector");
      expect((await startApproval(oauthReqInfo)).body).toMatchObject({ code: "approval_disabled" });
      expect((await ext(relay, "details", "x".repeat(32), OWNER)).body).toMatchObject({ error: "not_enabled" });
    }
  });

  it("mcp.ANY_CLIENT.16 switching it off after Allow stops the completion", async () => {
    const relay = createRelay({ mode: "on" });
    const { oauthReqInfo } = await signInPage(relay, LOOPBACK_REDIRECT, "MCP Inspector");
    const { body } = await startApproval(oauthReqInfo);
    expect((await allow(relay, body.requestId)).body.status).toBe("approved");
    await relay.kv.put(REDIRECT_POLICY_KEY, JSON.stringify({ mode: "allowlist" }));
    resetRedirectPolicyCache();
    expect((await complete(body.requestId, oauthReqInfo)).body).toMatchObject({ code: "approval_disabled" });
  });

  it("mcp.ANY_CLIENT.16 GET /authorize/approval/try sets the tester cookie; ?off=1 clears it", async () => {
    const { GET } = await import("@/app/authorize/approval/try/route");
    const on = await GET(new Request(`${ORIGIN}/authorize/approval/try`));
    expect(on.headers.get("set-cookie")).toMatch(new RegExp(`^${TESTER_COOKIE}=1; Path=/authorize; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$`));
    const off = await GET(new Request(`${ORIGIN}/authorize/approval/try?off=1`));
    expect(off.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("mcp.ANY_CLIENT.18 the approval answers only its own sign-in page, for the very request", () => {
  it("mcp.ANY_CLIENT.18 the same app, redirect and PKCE challenge with another state can't spend the approval", async () => {
    const relay = createRelay();
    const { clientId, oauthReqInfo } = await signInPage(relay, LOOPBACK_REDIRECT, "MCP Inspector");
    const { body } = await startApproval(oauthReqInfo);
    await allow(relay, body.requestId);
    const other = await authorize(relay, clientId, LOOPBACK_REDIRECT, VERIFIER, "attacker-state");
    expect((await complete(body.requestId, other.oauthReqInfo)).body).toMatchObject({ code: "approval_mismatch" });
    expect((await complete(body.requestId, oauthReqInfo)).status).toBe(200);
  });

  it("mcp.ANY_CLIENT.18 a cross-site simple request or another origin is refused", async () => {
    const relay = createRelay();
    const { oauthReqInfo } = await signInPage(relay, LOOPBACK_REDIRECT, "MCP Inspector");
    const sneaky = await approvalStart(post("/authorize/approval/start", { oauthReqInfo }, undefined, { "content-type": "text/plain; x=application/json" }));
    expect(sneaky.status).toBe(400);
    const foreign = await approvalStart(post("/authorize/approval/start", { oauthReqInfo }, undefined, { origin: "https://evil.example.org" }));
    expect(foreign.status).toBe(403);
    const own = await approvalStart(post("/authorize/approval/start", { oauthReqInfo }, undefined, { origin: ORIGIN }));
    expect(own.status).toBe(200);
    const statusForeign = await approvalStatus(post("/authorize/approval/status", { requestId: "x".repeat(32) }, undefined, { origin: "https://evil.example.org" }));
    expect(statusForeign.status).toBe(403);
  });
});

describe("mcp.ANY_CLIENT.19 an unknown website's connection ends after 90 days without use", () => {
  async function grantLifetime(relay: Relay, redirect: string, name: string, chosen: string) {
    const { oauthReqInfo } = await signInPage(relay, redirect, name);
    const { body } = await startApproval(oauthReqInfo);
    await allow(relay, body.requestId);
    const response = await approvalComplete(post("/authorize/approval/complete", { requestId: body.requestId, oauthReqInfo, connectionLifetime: chosen }));
    expect(response.status).toBe(200);
    const accountRef = (await deriveAccountRef(PHONE, "phone-ref-secret"))!;
    const grants = await relay.helpers.listUserGrants(accountRef);
    return grants.items.map((g: any) => g.metadata?.lifetime);
  }

  it("mcp.ANY_CLIENT.19 'until I disconnect it' is not offered to an unknown website; a loopback app keeps its choice", async () => {
    expect(await grantLifetime(createRelay(), N8N_REDIRECT, "n8n", "until-revoked")).toEqual(["inactive-90d"]);
    expect(await grantLifetime(createRelay(), LOOPBACK_REDIRECT, "MCP Inspector", "until-revoked")).toEqual(["until-revoked"]);
  });
});
