/**
 * How long an AI app (Claude, ChatGPT, …) stays connected — mcp.CLOUD_RELAY.9–12.
 *
 * The person picks it on the consent page: until 90 days pass without use
 * (the default), for one year, or until they disconnect it. The OAuth library
 * can only give a connection a FIXED refresh-token lifetime, set when the
 * connection is created, so it enforces the one-year choice by itself. The
 * other two are open-ended in the library; for "90 days without use" the relay
 * records every successful token exchange and refuses — and revokes — a
 * refresh that arrives after 90 idle days.
 *
 * Before this, every connection got the library defaults: a refresh token that
 * died 30 days after the person connected, however much they used it, and a
 * client registration that died at 90 days. Connections from that era carry
 * no `lifetime`; they move to the default on their next refresh, or through
 * scripts/migrate-connection-lifetimes.mjs.
 */
import type {
  OAuthHelpers,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import {
  DEFAULT_CONNECTION_LIFETIME,
  FIXED_LIFETIME_DAYS,
  IDLE_LIMIT_DAYS,
  parseConnectionLifetime,
  type ConnectionLifetime,
} from "./connection-lifetime-options";

const DAY_SECONDS = 24 * 3600;

export const IDLE_LIMIT_SECONDS = IDLE_LIMIT_DAYS * DAY_SECONDS;

export const FIXED_LIFETIME_SECONDS = FIXED_LIFETIME_DAYS * DAY_SECONDS;

// Activity records outlive the idle limit, then clean themselves up.
const ACTIVITY_RETENTION_SECONDS = IDLE_LIMIT_SECONDS + 30 * DAY_SECONDS;

export const IDLE_EXPIRED_DESCRIPTION =
  "This connection ended after 90 days without use. Connect Kaption again to continue.";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * OAuthProvider `tokenExchangeCallback`: gives a one-year connection its
 * library lifetime at the first token exchange. The library rejects
 * `refreshTokenTTL` during a refresh, so only the authorization-code grant is
 * answered; every other connection keeps the provider's open-ended default.
 */
export function connectionLifetimeCallback(
  options: TokenExchangeCallbackOptions,
): TokenExchangeCallbackResult | undefined {
  if ((options.grantType as string) !== "authorization_code") return undefined;
  if (parseConnectionLifetime(options.props?.connectionLifetime) !== "fixed-1y") return undefined;
  return { refreshTokenTTL: FIXED_LIFETIME_SECONDS };
}

export interface GrantRef {
  userId: string;
  grantId: string;
}

/** The `userId:grantId` a library token starts with, or null when it isn't one. */
export function grantRefFromToken(token: unknown): GrantRef | null {
  if (typeof token !== "string") return null;
  const parts = token.split(":");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return { userId: parts[0], grantId: parts[1] };
}

export const grantKey = (ref: GrantRef) => `grant:${ref.userId}:${ref.grantId}`;

/** When the connection last completed a token exchange (epoch seconds). */
export const activityKey = (ref: GrantRef) => `conn-activity:${ref.userId}:${ref.grantId}`;

/** The parts of the library's stored grant this module reads or rewrites. */
export interface StoredGrant {
  clientId: string;
  createdAt: number;
  expiresAt?: number;
  refreshTokenId?: string;
  previousRefreshTokenId?: string;
  metadata?: { lifetime?: string; lifetimeSince?: number; [key: string]: unknown } | null;
  [key: string]: unknown;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The library's own test: the token hashes to the grant's current or previous refresh-token id. */
async function isGrantRefreshToken(grant: StoredGrant, token: string): Promise<boolean> {
  const id = await sha256Hex(token);
  return id === grant.refreshTokenId || id === grant.previousRefreshTokenId;
}

export async function recordActivity(kv: KVNamespace, ref: GrantRef, at = nowSeconds()): Promise<void> {
  await kv.put(activityKey(ref), String(at), { expirationTtl: ACTIVITY_RETENTION_SECONDS });
}

/** When the idle clock started: the last use, or when the connection or its lifetime began. */
function idleSince(grant: Pick<StoredGrant, "createdAt" | "metadata">, lastUsed: number): number {
  return Math.max(lastUsed, Number(grant.metadata?.lifetimeSince) || 0, Number(grant.createdAt) || 0);
}

/** Rewrites a client registration without its KV expiration, if it has one. */
export async function dropClientExpiry(kv: KVNamespace, clientId: string): Promise<void> {
  if (!clientId) return;
  const name = `client:${clientId}`;
  const listed = await kv.list({ prefix: name, limit: 10 });
  if (!listed.keys.find((key) => key.name === name)?.expiration) return;
  const value = await kv.get(name);
  if (value !== null) await kv.put(name, value);
}

/**
 * mcp.CLOUD_RELAY.11 — a connection from before lifetimes, moved to the
 * default: its 30-day deadline dropped, its idle clock started at `at`.
 */
export function withDefaultLifetime(grant: StoredGrant, at: number): StoredGrant {
  const updated: StoredGrant = {
    ...grant,
    metadata: { ...(grant.metadata ?? {}), lifetime: DEFAULT_CONNECTION_LIFETIME, lifetimeSince: at },
  };
  delete updated.expiresAt;
  return updated;
}

/**
 * Moves a pre-lifetime connection to the default. Runs before the library
 * handles the refresh, so the library reads — and keeps — the updated record.
 */
export async function adoptDefaultLifetime(
  kv: KVNamespace,
  ref: GrantRef,
  grant: StoredGrant,
  at = nowSeconds(),
): Promise<void> {
  // No expiration: the connection is open-ended in the library from now on.
  await kv.put(grantKey(ref), JSON.stringify(withDefaultLifetime(grant, at)));
  await dropClientExpiry(kv, grant.clientId);
}

export type RefreshVerdict = "allow" | "idle-expired";

/**
 * Decides a refresh before the library runs it. Only a caller holding the
 * connection's valid refresh token changes anything; anything else is left for
 * the library to reject.
 */
export async function checkRefresh(
  kv: KVNamespace,
  refreshToken: string,
  at = nowSeconds(),
): Promise<RefreshVerdict> {
  const ref = grantRefFromToken(refreshToken);
  if (!ref) return "allow";
  const grant = await kv.get<StoredGrant>(grantKey(ref), "json");
  if (!grant || !(await isGrantRefreshToken(grant, refreshToken))) return "allow";
  if (!grant.metadata?.lifetime) {
    await adoptDefaultLifetime(kv, ref, grant, at);
    return "allow";
  }
  if (parseConnectionLifetime(grant.metadata.lifetime) !== "inactive-90d") return "allow";
  const since = idleSince(grant, Number(await kv.get(activityKey(ref))) || 0);
  return since > 0 && at - since > IDLE_LIMIT_SECONDS ? "idle-expired" : "allow";
}

function invalidGrant(description: string): Response {
  return Response.json(
    { error: "invalid_grant", error_description: description },
    { status: 400, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!(request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) return null;
  try {
    return new URLSearchParams(await request.clone().text());
  } catch {
    return null;
  }
}

/**
 * Wraps the library's `POST /token`. A refresh on a connection idle past its
 * limit is refused and the connection revoked; every successful exchange
 * restarts the idle clock. This bookkeeping never fails a token request on
 * its own — the library still decides everything else.
 */
export async function handleTokenRequest(
  request: Request,
  env: { OAUTH_KV: KVNamespace },
  ctx: ExecutionContext,
  forward: (request: Request) => Promise<Response>,
  helpers: () => OAuthHelpers,
): Promise<Response> {
  const form = await readForm(request);
  const grantType = form?.get("grant_type");

  if (grantType === "refresh_token") {
    const refreshToken = form?.get("refresh_token") ?? "";
    const ref = grantRefFromToken(refreshToken);
    let verdict: RefreshVerdict = "allow";
    try {
      verdict = await checkRefresh(env.OAUTH_KV, refreshToken);
    } catch (error) {
      console.error("[lifetime] refresh check failed:", error instanceof Error ? error.message : error);
    }
    if (verdict === "idle-expired" && ref) {
      try {
        await helpers().revokeGrant(ref.grantId, ref.userId);
        await env.OAUTH_KV.delete(activityKey(ref));
      } catch (error) {
        console.error("[lifetime] revoking an idle connection failed:", error instanceof Error ? error.message : error);
      }
      return invalidGrant(IDLE_EXPIRED_DESCRIPTION);
    }
    const response = await forward(request);
    if (response.ok && ref) ctx.waitUntil(recordActivity(env.OAUTH_KV, ref).catch(() => undefined));
    return response;
  }

  if (grantType === "authorization_code") {
    const response = await forward(request);
    if (response.ok) {
      const body = (await response.clone().json().catch(() => null)) as { refresh_token?: unknown } | null;
      const ref = grantRefFromToken(body?.refresh_token);
      if (ref) ctx.waitUntil(recordActivity(env.OAUTH_KV, ref).catch(() => undefined));
    }
    return response;
  }

  return forward(request);
}

/** One AI app connection, as the extension's "Connected apps" list shows it. */
export interface ConnectionView {
  id: string;
  appName: string;
  appUrl: string | null;
  /** Epoch ms. */
  connectedAt: number;
  /** Epoch ms of the last token exchange; null when none is on record. */
  lastUsedAt: number | null;
  lifetime: ConnectionLifetime;
  /** Epoch ms when it disconnects on its own; null means only when disconnected. */
  endsAt: number | null;
}

/** mcp.CLOUD_RELAY.12 — the account's connections, newest first. */
export async function listConnections(
  helpers: OAuthHelpers,
  kv: KVNamespace,
  userId: string,
): Promise<ConnectionView[]> {
  const views: ConnectionView[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, { cursor, limit: 100 });
    for (const grant of page.items) {
      const [client, lastUsedRaw] = await Promise.all([
        helpers.lookupClient(grant.clientId).catch(() => null),
        kv.get(activityKey({ userId, grantId: grant.id })),
      ]);
      const lastUsed = Number(lastUsedRaw) || 0;
      const lifetime = parseConnectionLifetime(grant.metadata?.lifetime);
      // A pre-lifetime connection keeps its old library deadline until it
      // moves to the default; never promise past it.
      const libraryEnd = grant.expiresAt ?? Number.POSITIVE_INFINITY;
      let endsAt = Number.POSITIVE_INFINITY;
      if (lifetime === "fixed-1y") endsAt = libraryEnd;
      if (lifetime === "inactive-90d") {
        endsAt = Math.min(idleSince(grant, lastUsed) + IDLE_LIMIT_SECONDS, libraryEnd);
      }
      views.push({
        id: grant.id,
        appName: client?.clientName?.trim() || "AI app",
        appUrl: client?.clientUri ?? null,
        connectedAt: grant.createdAt * 1000,
        lastUsedAt: lastUsed ? lastUsed * 1000 : null,
        lifetime,
        endsAt: Number.isFinite(endsAt) ? endsAt * 1000 : null,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return views.sort((a, b) => b.connectedAt - a.connectedAt);
}

/** mcp.CLOUD_RELAY.12 — revokes one of the account's connections. */
export async function disconnect(
  helpers: OAuthHelpers,
  kv: KVNamespace,
  userId: string,
  grantId: string,
): Promise<void> {
  await helpers.revokeGrant(grantId, userId);
  await kv.delete(activityKey({ userId, grantId }));
}
