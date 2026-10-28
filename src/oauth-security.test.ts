/**
 * The relay's OAuth surface driven through createFetchHandler over the REAL OAuth library (FakeKV, no mocks of the
 * provider): mcp.CLOUD_RELAY.16 (redirect URIs), .17 (Brazilian numbers), .18 (resource of /sse and /mcp?… addresses,
 * error page), .19 (one connector per number), .20 (?phone= is never a credential).
 */
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { buildOAuthOptions, canonicalResource, createFetchHandler } from "./index";
import { deriveAccountRef } from "./otp";
import {
  accountRefsForPhone,
  aliasKey,
  brazilMobileVariant,
  rememberPhoneAlias,
  relayWithAlias,
} from "./phone-alias";
import { checkClientRegistration, classifyRedirectUri } from "./redirect-policy";
import { connectorAddress } from "./connector-address";
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

const ORIGIN = "https://mcp.kaptionai.com";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const JWT_SECRET = "jwt-secret";
const PHONE_REF_SECRET = "phone-ref-secret";
const CODE_VERIFIER = "kaption-test-code-verifier-0123456789-abcdefghijklmnop";
// Fictional Brazilian mobile line (area code 51), written both ways.
const BR_WITH_9 = "5551991234567";
const BR_WITHOUT_9 = "555191234567";

function createRelay() {
  const kv = new FakeKV();
  const env = {
    OAUTH_KV: kv,
    JWT_SECRET,
    PHONE_REF_SECRET,
    INTERNAL_API_KEY: "internal-api-key",
    EPHEMERAL_STATE_SECRET: "ephemeral-state-secret",
  } as unknown as Env;
  const next = vi.fn(async (_request: Request) => new Response("<html>sign in</html>", {
    headers: { "Content-Type": "text/html" },
  }));
  const handler = createFetchHandler({ fetch: next });
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const call = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`${ORIGIN}${path}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    return response;
  };
  const helpers = getOAuthApi(buildOAuthOptions(ORIGIN, { fetch: next }), env);
  return { kv, env, call, next, helpers };
}

type Relay = ReturnType<typeof createRelay>;

const register = (relay: Relay, redirectUris: string[], name = "Claude") =>
  relay.call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
  });

async function registeredClient(relay: Relay, redirect = CLAUDE_REDIRECT): Promise<string> {
  const response = await register(relay, [redirect]);
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authorizeQuery(clientId: string, extra: Record<string, string> = {}, redirect = CLAUDE_REDIRECT) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    state: "state",
    code_challenge: await pkceChallenge(CODE_VERIFIER),
    code_challenge_method: "S256",
    ...extra,
  }).toString();
}

const HTML = { headers: { accept: "text/html,*/*;q=0.8", "accept-language": "en" } };

const jwtFor = (phone: string) =>
  new SignJWT({ phoneNumber: phone })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));

describe("mcp.CLOUD_RELAY.16 only known AI apps and this computer receive a sign-in", () => {
  it("refuses a registration with an attacker's redirect (security report #2198) and stores nothing", async () => {
    const relay = createRelay();
    for (const uris of [
      ["https://attacker-alpha.example.com/cb"],
      [" https://attacker-alpha.example.com/cb"],
      [CLAUDE_REDIRECT, "https://attacker-beta.example.com/cb"],
      ["http://claude.ai/api/mcp/auth_callback"],
      ["https://claude.ai.attacker.example/cb"],
      ["https://evilclaude.ai/cb"],
      ["https://storage.googleusercontent.com/x"],
      ["evilapp://callback"],
    ]) {
      const response = await register(relay, uris, "ProbeAlpha");
      expect(response.status, uris.join()).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
    expect((await relay.kv.list({ prefix: "client:" })).keys).toEqual([]);
  });

  it("still registers Claude, ChatGPT, Gemini and every loopback/desktop client real people connected with", async () => {
    const relay = createRelay();
    for (const uri of [
      CLAUDE_REDIRECT,
      "https://claude.com/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://platform.openai.com/apps-manage/oauth",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "https://app.notion.com/workflows/mcp/oauth/callback",
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1-mcp_kaptionai_com",
      "http://localhost:53682/callback", // Claude Code
      "http://127.0.0.1:1455/auth/callback", // Codex
      "http://127.0.0.1:33418/", // VS Code
      "http://[::1]:8080/oauth/callback",
      "claude://claude.ai/mcp-auth-callback/sdk",
      "cursor://anysphere.cursor-retrieval/oauth/user-kaption/callback",
    ]) {
      expect((await register(relay, [uri])).status, uri).toBe(201);
    }
  });

  it("a client registered before the rule, with an attacker's redirect, can't start a sign-in: a page, nothing rendered", async () => {
    const relay = createRelay();
    const clientId = await registeredClient(relay);
    // As registered before this change (the library never checked the host).
    const stored = relay.kv.json<Record<string, unknown>>(`client:${clientId}`)!;
    await relay.kv.put(`client:${clientId}`, JSON.stringify({ ...stored, redirectUris: ["https://attacker-alpha.example.com/cb"] }));

    const response = await relay.call(
      `/authorize?${await authorizeQuery(clientId, {}, "https://attacker-alpha.example.com/cb")}`,
      HTML,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Kaption doesn&#39;t connect to this app");
    expect(relay.next).not.toHaveBeenCalled();
  });

  it("classifies hosts by the real domain, never by a look-alike", () => {
    expect(classifyRedirectUri("https://claude.ai/x")).toBe("web");
    expect(classifyRedirectUri("https://sub.chatgpt.com/x")).toBe("web");
    expect(classifyRedirectUri("http://localhost.attacker.example/cb")).toBeNull();
    expect(classifyRedirectUri("https://user:pw@claude.ai/x")).toBeNull();
    expect(classifyRedirectUri("https://claude.ai/x#frag")).toBeNull();
    expect(classifyRedirectUri("javascript:alert(1)")).toBeNull();
    expect(checkClientRegistration({ clientMetadata: { redirect_uris: [CLAUDE_REDIRECT] } })).toBeUndefined();
  });
});

describe("mcp.CLOUD_RELAY.18 the address the app was given is the resource (#1735)", () => {
  it("canonicalizes /sse, /sse?phone= and /mcp?account= on our own origins, and nothing else", () => {
    expect(canonicalResource("https://mcp-ext.kaptionai.com/sse?phone=5491100000000")).toBe("https://mcp-ext.kaptionai.com/mcp");
    expect(canonicalResource("https://mcp.kaptionai.com/sse")).toBe("https://mcp.kaptionai.com/mcp");
    expect(canonicalResource("https://mcp.kaptionai.com/mcp/?account=1234")).toBe("https://mcp.kaptionai.com/mcp");
    expect(canonicalResource("https://attacker.example/mcp")).toBe("https://attacker.example/mcp");
    expect(canonicalResource("https://mcp.kaptionai.com/other")).toBe("https://mcp.kaptionai.com/other");
  });

  it("a sign-in for the SSE address or a per-number address opens the sign-in page; a foreign resource gets a page, not a 500", async () => {
    const relay = createRelay();
    const clientId = await registeredClient(relay);
    for (const resource of [`${ORIGIN}/sse?phone=5491100000000`, `${ORIGIN}/sse`, `${ORIGIN}/mcp?account=1234`, `${ORIGIN}/mcp`]) {
      relay.next.mockClear();
      const response = await relay.call(`/authorize?${await authorizeQuery(clientId, { resource })}`, HTML);
      expect(response.status, resource).toBe(200);
      expect(relay.next).toHaveBeenCalledTimes(1);
      expect(new URL(relay.next.mock.calls[0][0].url).searchParams.get("_oauthReqInfo")).toBeTruthy();
    }
    const foreign = await relay.call(`/authorize?${await authorizeQuery(clientId, { resource: "https://attacker.example/mcp" })}`, HTML);
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("content-type")).toContain("text/html");
  });

  it("the token exchange accepts the same address, and the token works on /sse and /mcp", async () => {
    const relay = createRelay();
    const clientId = await registeredClient(relay);
    const resource = `${ORIGIN}/sse?phone=5491100000000`;
    const request = await relay.helpers.parseAuthRequest(
      new Request(`${ORIGIN}/authorize?${await authorizeQuery(clientId, { resource: canonicalResource(resource) })}`),
    );
    const { redirectTo } = await relay.helpers.completeAuthorization({
      request,
      userId: "acct_test",
      scope: request.scope,
      metadata: { label: "WhatsApp" },
      props: { accountRef: "acct_test" },
    });
    const token = await relay.call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code")!,
        redirect_uri: CLAUDE_REDIRECT,
        client_id: clientId,
        code_verifier: CODE_VERIFIER,
        resource,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const { access_token } = (await token.json()) as { access_token: string };
    for (const path of ["/sse", "/mcp"]) {
      const response = await relay.call(path, { headers: { Authorization: `Bearer ${access_token}` } });
      expect(response.status, path).toBe(200);
    }
  });
});

describe("mcp.CLOUD_RELAY.20 a phone number in the address is never a credential (#1753/#1573)", () => {
  it("/sse?phone= and /mcp?phone= without a token answer 401 and reach no tool", async () => {
    const relay = createRelay();
    for (const path of ["/sse?phone=5491155551234", "/mcp?phone=5491155551234"]) {
      const response = await relay.call(path, { headers: { Accept: "text/event-stream, application/json" } });
      expect(response.status, path).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
    }
  });

  it("a made-up token with someone's phone in the address is refused too", async () => {
    const relay = createRelay();
    const response = await relay.call("/mcp?phone=5491155551234", {
      headers: { Authorization: "Bearer acct_x:grant:secret" },
    });
    expect(response.status).toBe(401);
  });
});

describe("mcp.CLOUD_RELAY.17 a Brazilian mobile number with or without the 9 is one line (#2016, #10002224)", () => {
  it("knows the other form of Brazilian mobiles only", () => {
    expect(brazilMobileVariant(BR_WITH_9)).toBe(BR_WITHOUT_9);
    expect(brazilMobileVariant(`+${BR_WITHOUT_9}`)).toBe(BR_WITH_9);
    expect(brazilMobileVariant("555132345678")).toBeNull(); // landline (subscriber starts with 3)
    expect(brazilMobileVariant("5491155551234")).toBeNull(); // Argentina
    expect(brazilMobileVariant("550991234567")).toBeNull(); // area code 09 doesn't exist
  });

  it("the extension's sign-in records the alias; a call for the other form's connection reaches the extension", async () => {
    const kv = new FakeKV();
    const withRef = (await deriveAccountRef(BR_WITH_9, PHONE_REF_SECRET))!;
    const withoutRef = (await deriveAccountRef(BR_WITHOUT_9, PHONE_REF_SECRET))!;
    // The extension's Kaption session carries WhatsApp's form (without the 9) and joins that room.
    await rememberPhoneAlias(kv as unknown as KVNamespace, BR_WITHOUT_9, withoutRef, PHONE_REF_SECRET);
    expect(await kv.get(aliasKey(withRef))).toBe(withoutRef);

    const rooms: Record<string, { handleMcpRequest: (m: string, p: unknown) => Promise<unknown> }> = {
      [withRef]: { handleMcpRequest: async () => { throw new Error("Extension not connected. Open WhatsApp Web…"); } },
      [withoutRef]: { handleMcpRequest: async (method) => ({ answeredBy: "extension", method }) },
    };
    const env = {
      OAUTH_KV: kv,
      RELAY_ROOM: { idFromName: (name: string) => name, get: (id: string) => rooms[id] },
    } as unknown as Env;
    // The person signed in to Codex with the 9: their connection is the other room's.
    expect(await relayWithAlias(env, withRef, "query", {})).toEqual({ answeredBy: "extension", method: "query" });
    // Without an alias, the honest error stands; other errors are never retried elsewhere.
    await expect(relayWithAlias({ ...env, OAUTH_KV: new FakeKV() } as unknown as Env, withRef, "query", {}))
      .rejects.toThrow(/Extension not connected/);
    rooms[withRef] = { handleMcpRequest: async () => { throw new Error("Request timed out after 120s"); } };
    await expect(relayWithAlias(env, withRef, "query", {})).rejects.toThrow(/timed out/);
  });

  it("Connected apps lists and disconnects a connection made with the other form", async () => {
    const relay = createRelay();
    const clientId = await registeredClient(relay, "http://127.0.0.1:1455/auth/callback");
    const withRef = (await deriveAccountRef(BR_WITH_9, PHONE_REF_SECRET))!;
    const request = await relay.helpers.parseAuthRequest(
      new Request(`${ORIGIN}/authorize?${await authorizeQuery(clientId, {}, "http://127.0.0.1:1455/auth/callback")}`),
    );
    await relay.helpers.completeAuthorization({
      request,
      userId: withRef,
      scope: request.scope,
      metadata: { label: "WhatsApp", lifetime: "inactive-90d" },
      props: { accountRef: withRef },
    });
    // The extension asks with its own session: WhatsApp's form, without the 9.
    const auth = { Authorization: `Bearer ${await jwtFor(BR_WITHOUT_9)}` };
    const listed = (await (await relay.call("/ext/connections", { headers: auth })).json()) as {
      connections: { id: string; appName: string }[];
    };
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0].appName).toBe("Claude");
    const removed = await relay.call(`/ext/connections/${listed.connections[0].id}`, { method: "DELETE", headers: auth });
    expect(removed.status).toBe(200);
    const after = (await (await relay.call("/ext/connections", { headers: auth })).json()) as { connections: unknown[] };
    expect(after.connections).toEqual([]);
    expect(await accountRefsForPhone("5491155551234", PHONE_REF_SECRET)).toHaveLength(1);
  });
});

describe("mcp.CLOUD_RELAY.19 one connector per WhatsApp number (#10002290)", () => {
  it("the /connect page gives each number its own address, labelled by the last four digits it already shows", () => {
    expect(connectorAddress(ORIGIN, "+91 ••• 2096")).toBe(`${ORIGIN}/mcp?account=2096`);
    expect(connectorAddress(ORIGIN, "+91 ••• 3039")).toBe(`${ORIGIN}/mcp?account=3039`);
    expect(connectorAddress(ORIGIN, null)).toBe(`${ORIGIN}/mcp`);
  });

  it("/mcp?phone= pre-fills the sign-in form like /sse?phone= (a hint only)", async () => {
    const relay = createRelay();
    const clientId = await registeredClient(relay);
    await relay.call("/mcp?phone=5491155551234", { headers: { "cf-connecting-ip": "203.0.113.7" } });
    await relay.call(`/authorize?${await authorizeQuery(clientId)}`, {
      headers: { ...HTML.headers, "cf-connecting-ip": "203.0.113.7" },
    });
    expect(new URL(relay.next.mock.calls[0][0].url).searchParams.get("_loginHint")).toBe("5491155551234");
  });
});
