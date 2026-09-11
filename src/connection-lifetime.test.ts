import OAuthProvider, {
  getOAuthApi,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXED_LIFETIME_SECONDS,
  IDLE_EXPIRED_DESCRIPTION,
  IDLE_LIMIT_SECONDS,
  activityKey,
  connectionLifetimeCallback,
  grantKey,
  grantRefFromToken,
  handleTokenRequest,
  withDefaultLifetime,
  type ConnectionView,
  type StoredGrant,
} from "./connection-lifetime";
import type { ConnectionLifetime } from "./connection-lifetime-options";
import { buildOAuthOptions, createFetchHandler } from "./index";
import { deriveAccountRef } from "./otp";
import { VerifyOTPSchema } from "./schemas";
import type { Env } from "./types";

vi.mock("./relay-mcp", () => ({
  RelayMCP: {
    serveSSE: () => ({ fetch: async () => new Response("sse") }),
    serve: () => ({ fetch: async () => new Response("mcp") }),
  },
}));

vi.mock("./relay-room", () => ({
  RelayRoom: class RelayRoom {},
}));

vi.mock("./deployment-chain", () => ({
  DeploymentChainDO: class DeploymentChainDO {},
}));

const DAY = 24 * 3600;
const ORIGIN = "https://mcp.kaptionai.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_VERIFIER = "kaption-test-code-verifier-0123456789-abcdefghijklmnop";
const JWT_SECRET = "jwt-secret";
const PHONE_REF_SECRET = "phone-ref-secret";
const PHONE = "5491155551234";
const OTHER_PHONE = "5491155559876";
const NEXT = { fetch: async () => new Response("next") };

/** Workers KV as the OAuth library uses it, with expirations on the (fakeable) clock. */
class FakeKV {
  private readonly entries = new Map<string, { value: string; expiration?: number }>();

  private entry(key: string) {
    const entry = this.entries.get(key);
    if (entry?.expiration !== undefined && entry.expiration <= Date.now() / 1000) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string, type?: string | { type?: string }) {
    const entry = this.entry(key);
    if (!entry) return null;
    const kind = typeof type === "string" ? type : type?.type;
    return kind === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options: { expiration?: number; expirationTtl?: number } = {}) {
    const expiration =
      options.expiration ??
      (options.expirationTtl === undefined ? undefined : Math.floor(Date.now() / 1000) + options.expirationTtl);
    this.entries.set(key, { value: String(value), expiration });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  async list({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const names = [...this.entries.keys()].filter((name) => name.startsWith(prefix) && this.entry(name)).sort();
    const start = Number(cursor ?? 0);
    const end = start + limit;
    return {
      keys: names.slice(start, end).map((name) => ({ name, expiration: this.entries.get(name)?.expiration })),
      list_complete: end >= names.length,
      cursor: end >= names.length ? undefined : String(end),
    };
  }

  json<T = StoredGrant>(key: string): T | null {
    const entry = this.entry(key);
    return entry ? (JSON.parse(entry.value) as T) : null;
  }

  expirationOf(key: string): number | undefined {
    return this.entry(key)?.expiration;
  }
}

interface Target {
  call(path: string, init?: RequestInit): Promise<Response>;
  helpers: OAuthHelpers;
}

function createContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending.splice(0)) };
}

/** The relay as deployed: createFetchHandler over the real OAuth library. */
function createRelay() {
  const kv = new FakeKV();
  const env = {
    OAUTH_KV: kv,
    JWT_SECRET,
    PHONE_REF_SECRET,
    INTERNAL_API_KEY: "internal-api-key",
    EPHEMERAL_STATE_SECRET: "ephemeral-state-secret",
  } as unknown as Env;
  const handler = createFetchHandler(NEXT);
  const { ctx, settle } = createContext();
  const relay: Target & { kv: FakeKV; env: Env } = {
    kv,
    env,
    helpers: getOAuthApi(buildOAuthOptions(ORIGIN, NEXT), env),
    async call(path, init) {
      const response = await handler(new Request(`${ORIGIN}${path}`, init), env, ctx);
      await settle();
      return response;
    },
  };
  return relay;
}

/** The relay before connection lifetimes: the same provider on the library's defaults. */
function legacyRelay(env: Env): Target {
  const { refreshTokenTTL, clientRegistrationTTL, tokenExchangeCallback, ...options } = buildOAuthOptions(
    ORIGIN,
    NEXT,
  );
  const provider = new OAuthProvider(options);
  const { ctx, settle } = createContext();
  return {
    helpers: getOAuthApi(options, env),
    async call(path, init) {
      const response = await provider.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
      await settle();
      return response;
    },
  };
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function register(target: Target, clientName = "Claude"): Promise<string> {
  const response = await target.call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

/** The consent (completed as the verify-otp route does) and the app's code exchange. */
async function connect(
  target: Target,
  { clientId, userId, lifetime }: { clientId: string; userId: string; lifetime?: ConnectionLifetime },
): Promise<Tokens> {
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "kaption:access",
    state: "state",
    code_challenge: await pkceChallenge(CODE_VERIFIER),
    code_challenge_method: "S256",
  }).toString();
  const request = await target.helpers.parseAuthRequest(new Request(authorize));
  const { redirectTo } = await target.helpers.completeAuthorization({
    request,
    userId,
    scope: request.scope,
    // A connection from before lifetimes carries neither field.
    metadata: lifetime ? { label: "WhatsApp", lifetime } : { label: "WhatsApp" },
    props: lifetime ? { accountRef: userId, connectionLifetime: lifetime } : { accountRef: userId },
  });
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  const response = await target.call(
    "/token",
    form({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

const refresh = (target: Target, clientId: string, refreshToken: string) =>
  target.call("/token", form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }));

async function refreshOk(target: Target, clientId: string, refreshToken: string): Promise<Tokens> {
  const response = await refresh(target, clientId, refreshToken);
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

const grantOf = (token: string) => grantKey(grantRefFromToken(token)!);

const nowSeconds = () => Math.floor(Date.now() / 1000);

const advanceDays = (days: number) => vi.setSystemTime(Date.now() + days * DAY * 1000);

function kaptionJwt(phone: string): Promise<string> {
  return new SignJWT({ phoneNumber: phone })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connection lifetimes on the real OAuth provider (mcp.CLOUD_RELAY.9/10)", () => {
  it("keeps a 'While I use it' connection going past 30 days, for as long as it is used", async () => {
    const relay = createRelay();
    const clientId = await register(relay);
    let tokens = await connect(relay, { clientId, userId: "account-1", lifetime: "inactive-90d" });

    expect(relay.kv.json(grantOf(tokens.refresh_token))?.expiresAt).toBeUndefined();
    expect(relay.kv.expirationOf(grantOf(tokens.refresh_token))).toBeUndefined();

    for (let use = 0; use < 4; use++) {
      advanceDays(89);
      tokens = await refreshOk(relay, clientId, tokens.refresh_token);
    }
  });

  it("ends a 'While I use it' connection after 90 days without use, and revokes it", async () => {
    const relay = createRelay();
    const clientId = await register(relay);
    const tokens = await connect(relay, { clientId, userId: "account-1", lifetime: "inactive-90d" });

    advanceDays(91);
    const response = await refresh(relay, clientId, tokens.refresh_token);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant", error_description: IDLE_EXPIRED_DESCRIPTION });
    expect(relay.kv.json(grantOf(tokens.refresh_token))).toBeNull();
    expect(relay.kv.json(activityKey(grantRefFromToken(tokens.refresh_token)!))).toBeNull();
  });

  it("gives a 'For 1 year' connection one year, used or not", async () => {
    const relay = createRelay();
    const clientId = await register(relay);
    const connectedAt = nowSeconds();
    let tokens = await connect(relay, { clientId, userId: "account-1", lifetime: "fixed-1y" });

    expect(relay.kv.json(grantOf(tokens.refresh_token))?.expiresAt).toBe(connectedAt + FIXED_LIFETIME_SECONDS);

    advanceDays(200); // idle far longer than 90 days
    tokens = await refreshOk(relay, clientId, tokens.refresh_token);
    advanceDays(166); // day 366
    expect((await refresh(relay, clientId, tokens.refresh_token)).status).toBe(400);
  });

  it("keeps an 'Until I disconnect it' connection with no end", async () => {
    const relay = createRelay();
    const clientId = await register(relay);
    const tokens = await connect(relay, { clientId, userId: "account-1", lifetime: "until-revoked" });

    advanceDays(400);
    await refreshOk(relay, clientId, tokens.refresh_token);
  });

  it("no longer lets app registrations expire", async () => {
    const relay = createRelay();
    const clientId = await register(relay);

    expect(relay.kv.json(`client:${clientId}`)).not.toBeNull();
    expect(relay.kv.expirationOf(`client:${clientId}`)).toBeUndefined();
  });
});

describe("connections made before lifetimes (mcp.CLOUD_RELAY.11)", () => {
  it("move to 'While I use it' on their next refresh and outlive the old 30-day end", async () => {
    const relay = createRelay();
    const legacy = legacyRelay(relay.env);
    const clientId = await register(legacy);
    const connectedAt = nowSeconds();
    let tokens = await connect(legacy, { clientId, userId: "account-1" });

    expect(relay.kv.json(grantOf(tokens.refresh_token))?.expiresAt).toBe(connectedAt + 30 * DAY);
    expect(relay.kv.expirationOf(`client:${clientId}`)).toBe(connectedAt + 90 * DAY);

    advanceDays(20);
    const movedAt = nowSeconds();
    tokens = await refreshOk(relay, clientId, tokens.refresh_token);

    const moved = relay.kv.json(grantOf(tokens.refresh_token));
    expect(moved?.expiresAt).toBeUndefined();
    expect(moved?.metadata).toEqual({ label: "WhatsApp", lifetime: "inactive-90d", lifetimeSince: movedAt });
    expect(relay.kv.expirationOf(grantOf(tokens.refresh_token))).toBeUndefined();
    expect(relay.kv.expirationOf(`client:${clientId}`)).toBeUndefined();

    advanceDays(25); // day 45 — the old refresh token would be dead by now
    tokens = await refreshOk(relay, clientId, tokens.refresh_token);
    advanceDays(91);
    expect((await refresh(relay, clientId, tokens.refresh_token)).status).toBe(400);
  });

  it("are left alone when the caller does not hold the connection's refresh token", async () => {
    const relay = createRelay();
    const legacy = legacyRelay(relay.env);
    const clientId = await register(legacy);
    const tokens = await connect(legacy, { clientId, userId: "account-1" });
    const { userId, grantId } = grantRefFromToken(tokens.refresh_token)!;

    const response = await refresh(relay, clientId, `${userId}:${grantId}:not-the-secret`);

    expect(response.status).toBe(400);
    const untouched = relay.kv.json(grantOf(tokens.refresh_token));
    expect(untouched?.expiresAt).toBeDefined();
    expect(untouched?.metadata).toEqual({ label: "WhatsApp" });
  });
});

describe("Connected apps — /ext/connections (mcp.CLOUD_RELAY.12)", () => {
  it("lists the account's own connections and disconnects one", async () => {
    const relay = createRelay();
    const account = (await deriveAccountRef(PHONE, PHONE_REF_SECRET))!;
    const someoneElse = (await deriveAccountRef(OTHER_PHONE, PHONE_REF_SECRET))!;
    const claude = await register(relay, "Claude");
    const chatgpt = await register(relay, "ChatGPT");

    const claudeConnectedAt = nowSeconds();
    const claudeTokens = await connect(relay, { clientId: claude, userId: account, lifetime: "inactive-90d" });
    advanceDays(1);
    const chatgptConnectedAt = nowSeconds();
    await connect(relay, { clientId: chatgpt, userId: account, lifetime: "fixed-1y" });
    await connect(relay, { clientId: claude, userId: someoneElse, lifetime: "until-revoked" });

    const headers = { Authorization: `Bearer ${await kaptionJwt(PHONE)}` };
    const listed = await relay.call("/ext/connections", { headers });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBe("*");
    const { connections } = (await listed.json()) as { connections: ConnectionView[] };
    expect(connections).toEqual([
      expect.objectContaining({
        appName: "ChatGPT",
        lifetime: "fixed-1y",
        connectedAt: chatgptConnectedAt * 1000,
        lastUsedAt: chatgptConnectedAt * 1000,
        endsAt: (chatgptConnectedAt + FIXED_LIFETIME_SECONDS) * 1000,
      }),
      expect.objectContaining({
        appName: "Claude",
        lifetime: "inactive-90d",
        connectedAt: claudeConnectedAt * 1000,
        lastUsedAt: claudeConnectedAt * 1000,
        endsAt: (claudeConnectedAt + IDLE_LIMIT_SECONDS) * 1000,
      }),
    ]);

    const removed = await relay.call(`/ext/connections/${connections[1].id}`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
    expect((await refresh(relay, claude, claudeTokens.refresh_token)).status).toBe(400);
    const after = (await (await relay.call("/ext/connections", { headers })).json()) as {
      connections: ConnectionView[];
    };
    expect(after.connections.map((connection) => connection.appName)).toEqual(["ChatGPT"]);
  });

  it("never reaches another account's connections", async () => {
    const relay = createRelay();
    const someoneElse = (await deriveAccountRef(OTHER_PHONE, PHONE_REF_SECRET))!;
    const claude = await register(relay);
    const theirTokens = await connect(relay, { clientId: claude, userId: someoneElse, lifetime: "inactive-90d" });
    const { grantId } = grantRefFromToken(theirTokens.refresh_token)!;
    const headers = { Authorization: `Bearer ${await kaptionJwt(PHONE)}` };

    const listed = (await (await relay.call("/ext/connections", { headers })).json()) as {
      connections: ConnectionView[];
    };
    expect(listed.connections).toEqual([]);
    expect((await relay.call(`/ext/connections/${grantId}`, { method: "DELETE", headers })).status).toBe(200);
    await refreshOk(relay, claude, theirTokens.refresh_token);
  });

  it("requires the extension's Kaption session", async () => {
    const relay = createRelay();

    expect((await relay.call("/ext/connections")).status).toBe(401);
    expect((await relay.call("/ext/connections", { headers: { Authorization: "Bearer not-a-jwt" } })).status).toBe(401);
    expect((await relay.call("/ext/connections/some-id", { method: "DELETE" })).status).toBe(401);
    const preflight = await relay.call("/ext/connections/some-id", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
  });
});

describe("connectionLifetimeCallback", () => {
  const exchange = (grantType: string, connectionLifetime?: string) =>
    connectionLifetimeCallback({ grantType, props: { connectionLifetime } } as unknown as TokenExchangeCallbackOptions);

  it("gives only a one-year connection a library lifetime, at its first token exchange", () => {
    expect(exchange("authorization_code", "fixed-1y")).toEqual({ refreshTokenTTL: FIXED_LIFETIME_SECONDS });
    expect(exchange("authorization_code", "inactive-90d")).toBeUndefined();
    expect(exchange("authorization_code", "until-revoked")).toBeUndefined();
    expect(exchange("authorization_code")).toBeUndefined();
  });

  it("never sets a lifetime during a refresh, which the library would reject", () => {
    expect(exchange("refresh_token", "fixed-1y")).toBeUndefined();
  });
});

describe("handleTokenRequest", () => {
  it("still lets the provider answer when the lifetime check itself fails", async () => {
    const kv = {
      get: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const forward = vi.fn(async () => Response.json({ access_token: "a", refresh_token: "u:g:next" }));
    const { ctx, settle } = createContext();

    const response = await handleTokenRequest(
      new Request(`${ORIGIN}/token`, form({ grant_type: "refresh_token", refresh_token: "u:g:secret" })),
      { OAUTH_KV: kv },
      ctx,
      forward,
      () => {
        throw new Error("not needed");
      },
    );
    await settle();

    expect(response.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
  });

  it("passes other grants and non-form bodies straight to the provider", async () => {
    const forward = vi.fn(async () => new Response("from provider"));
    const { ctx } = createContext();

    for (const init of [
      form({ grant_type: "client_credentials" }),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ]) {
      const response = await handleTokenRequest(
        new Request(`${ORIGIN}/token`, init),
        { OAUTH_KV: new FakeKV() as unknown as KVNamespace },
        ctx,
        forward,
        () => {
          throw new Error("not needed");
        },
      );
      expect(await response.text()).toBe("from provider");
    }
    expect(forward).toHaveBeenCalledTimes(2);
  });
});

describe("withDefaultLifetime", () => {
  it("drops the old deadline and keeps the rest of the record", () => {
    const legacy = {
      id: "grant",
      clientId: "client",
      createdAt: 100,
      expiresAt: 100 + 30 * DAY,
      metadata: { label: "WhatsApp" },
      refreshTokenId: "hash",
    } as StoredGrant;

    expect(withDefaultLifetime(legacy, 500)).toEqual({
      id: "grant",
      clientId: "client",
      createdAt: 100,
      metadata: { label: "WhatsApp", lifetime: "inactive-90d", lifetimeSince: 500 },
      refreshTokenId: "hash",
    });
  });
});

describe("the consent form", () => {
  it("accepts one of the three lifetimes, or none, and nothing else", () => {
    const base = { verifyTicket: "ticket", code: "123456" };
    for (const connectionLifetime of ["inactive-90d", "fixed-1y", "until-revoked", undefined]) {
      expect(VerifyOTPSchema.safeParse({ ...base, connectionLifetime }).success).toBe(true);
    }
    expect(VerifyOTPSchema.safeParse({ ...base, connectionLifetime: "forever" }).success).toBe(false);
  });
});
