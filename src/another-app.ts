/**
 * mcp.ANOTHER_APP — "Connect another app": an MCP client Kaption doesn't know (n8n, OpenBot, any website) signs in with
 * the same screens as Claude and ChatGPT (the Kaption code from WhatsApp, or the phone + WhatsApp code), plus a warning
 * that names the real redirect host and an "I know and trust this site" tick. Nothing changes for known apps
 * (CLOUD_RELAY.16): their registration, sign-in page and connections are exactly as before.
 *
 * Owner's switch (KV `mcp-another-app:policy`), audit log, rate limits and the 90-day idle rule live here.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hmacVerify } from "./otp";
import { classifyRedirectUri, isLoopbackHost } from "./redirect-policy";
import { readSlidingCounter, slidingStatus, writeSlidingCounter, type LimitStatus } from "./rate-limit";

// ─── mcp.ANOTHER_APP.1 — the owner's switch ─────────────────────────────────────────────────────────────────────

export type AnotherAppMode = "off" | "owners" | "on";

export interface AnotherAppPolicy {
  mode: AnotherAppMode;
  /** Mode "owners": the only phones (digits) an unknown website's sign-in completes for. */
  allowPhones: string[];
  /** Hosts refused for unknown websites (subdomains included). Known AI apps are never affected. */
  denyHosts: string[];
}

export const ANOTHER_APP_POLICY_KEY = "mcp-another-app:policy";
/** mcp.ANOTHER_APP.1 — the owner's numbers, the default allow list. */
export const OWNER_PHONES = ["17374202658", "17373427172"];
export const DEFAULT_ANOTHER_APP_POLICY: AnotherAppPolicy = { mode: "owners", allowPhones: OWNER_PHONES, denyHosts: [] };

function hostList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, ""))
    .filter((h) => /^[a-z0-9.-]{1,253}$/.test(h) && h.includes("."))
    .slice(0, 1000);
}

function phoneList(value: unknown): string[] {
  if (!Array.isArray(value)) return OWNER_PHONES;
  return value
    .filter((p): p is string | number => typeof p === "string" || typeof p === "number")
    .map((p) => String(p).replace(/[\s\-+()]/g, ""))
    .filter((p) => /^\d{8,15}$/.test(p))
    .slice(0, 200);
}

/** mcp.ANOTHER_APP.1 — a stored value as a policy; anything unreadable is the default. */
export function parseAnotherAppPolicy(raw: unknown): AnotherAppPolicy {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return DEFAULT_ANOTHER_APP_POLICY;
    }
  }
  if (!value || typeof value !== "object") return DEFAULT_ANOTHER_APP_POLICY;
  const v = value as Record<string, unknown>;
  const mode: AnotherAppMode = v.mode === "off" || v.mode === "on" ? v.mode : "owners";
  return { mode, allowPhones: phoneList(v.allowPhones), denyHosts: hostList(v.denyHosts) };
}

const POLICY_CACHE_MS = 60_000;
let cached: { at: number; policy: AnotherAppPolicy } | null = null;

/** mcp.ANOTHER_APP.1 — read at most once a minute per isolate; a failed read is the default. */
export async function loadAnotherAppPolicy(kv: Pick<KVNamespace, "get">, now = Date.now()): Promise<AnotherAppPolicy> {
  if (cached && now - cached.at < POLICY_CACHE_MS) return cached.policy;
  let policy = DEFAULT_ANOTHER_APP_POLICY;
  try {
    policy = parseAnotherAppPolicy(await kv.get(ANOTHER_APP_POLICY_KEY));
  } catch {
    policy = DEFAULT_ANOTHER_APP_POLICY;
  }
  cached = { at: now, policy };
  return policy;
}

/** Tests: forget the cached policy. */
export function resetAnotherAppPolicyCache(): void {
  cached = null;
}

// ─── mcp.ANOTHER_APP.2, .4 — what a redirect is ────────────────────────────────────────────────────────────────

const matchesHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * The host of an https redirect on a website Kaption doesn't know, or null when the redirect is a known app's,
 * loopback, an app scheme, or not a website address at all. Same byte-level checks as CLOUD_RELAY.16.
 */
export function unknownSiteHost(redirectUri: unknown): string | null {
  if (typeof redirectUri !== "string" || !redirectUri) return null;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(redirectUri)) return null;
  if (classifyRedirectUri(redirectUri) !== null) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hash || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (isLoopbackHost(host) || host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (!host.includes(".") || host.endsWith(".") || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

/** mcp.ANOTHER_APP.2, .4, .9 — whether the switch lets this unknown website register or start a sign-in. */
export function unknownSiteAllowed(host: string, policy: AnotherAppPolicy): boolean {
  if (policy.mode === "off") return false;
  return !matchesHost(host, policy.denyHosts);
}

/** mcp.ANOTHER_APP.7 — whether an unknown website's sign-in may complete for this phone (digits). */
export function phoneAllowed(phone: string | null | undefined, policy: AnotherAppPolicy): boolean {
  if (!phone) return false;
  if (policy.mode === "on") return true;
  return policy.mode === "owners" && policy.allowPhones.includes(phone.replace(/\D/g, ""));
}

/**
 * mcp.ANOTHER_APP.2 — OAuthProvider `clientRegistrationCallback`: a registration passes when every redirect is a known
 * app's (CLOUD_RELAY.16) or, with the switch on, an unknown website the switch allows. Anything else gets the same
 * refusal as before.
 */
export function registrationVerdict(
  uris: unknown,
  policy: AnotherAppPolicy,
): { ok: true; unknownHosts: string[] } | { ok: false } {
  if (!Array.isArray(uris) || uris.length === 0) return { ok: true, unknownHosts: [] };
  const unknownHosts: string[] = [];
  for (const uri of uris) {
    if (classifyRedirectUri(uri) !== null) continue;
    const host = unknownSiteHost(uri);
    if (!host || !unknownSiteAllowed(host, policy)) return { ok: false };
    unknownHosts.push(host);
  }
  return { ok: true, unknownHosts };
}

// ─── mcp.ANOTHER_APP.4 — PKCE ─────────────────────────────────────────────────────────────────────────────────────

/** mcp.ANOTHER_APP.4 — an unknown website must send a PKCE challenge with S256. */
export function hasS256Pkce(request: Pick<AuthRequest, "codeChallenge" | "codeChallengeMethod">): boolean {
  return typeof request.codeChallenge === "string"
    && /^[A-Za-z0-9_-]{43,128}$/.test(request.codeChallenge)
    && request.codeChallengeMethod === "S256";
}

// ─── mcp.ANOTHER_APP.6 — the signed request a sign-in page carries ─────────────────────────────────────────────

/** The OAuth request /authorize signed ([M3]: HMAC over the whole request), or null when it isn't ours. */
export async function readSignedRequest(oauthReqInfo: unknown, key: string): Promise<AuthRequest | null> {
  if (typeof oauthReqInfo !== "string" || !oauthReqInfo) return null;
  const raw = await hmacVerify(oauthReqInfo, key);
  if (!raw) return null;
  try {
    const request = JSON.parse(atob(raw)) as AuthRequest;
    return request?.clientId ? request : null;
  } catch {
    return null;
  }
}

// ─── mcp.ANOTHER_APP.10 — the audit log ────────────────────────────────────────────────────────────────────────

export type AuditEvent =
  | "registered"
  | "registration_refused"
  | "signin_started"
  | "signin_refused"
  | "approved"
  | "refused"
  | "refresh_refused";

export const AUDIT_PREFIX = "audit:another-app:";
const AUDIT_TTL_SECONDS = 180 * 24 * 3600;

export interface AuditEntry {
  event: AuditEvent;
  host?: string | null;
  clientId?: string | null;
  /** The account reference (never a phone number), cut to 13 characters as the grant labels are. */
  accountRef?: string | null;
  reason?: string;
}

/** mcp.ANOTHER_APP.10 — one line in KV (180 days) and in the logs. Never fails the request. */
export async function audit(kv: Pick<KVNamespace, "put">, entry: AuditEntry, now = Date.now()): Promise<void> {
  const record = {
    at: new Date(now).toISOString(),
    event: entry.event,
    host: entry.host ? String(entry.host).slice(0, 253) : null,
    clientId: entry.clientId ? String(entry.clientId).slice(0, 64) : null,
    account: entry.accountRef ? String(entry.accountRef).slice(0, 13) : null,
    ...(entry.reason ? { reason: entry.reason.slice(0, 64) } : {}),
  };
  console.log("[another-app]", JSON.stringify(record));
  try {
    const id = crypto.getRandomValues(new Uint8Array(6)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
    await kv.put(`${AUDIT_PREFIX}${record.at}:${id}`, JSON.stringify(record), { expirationTtl: AUDIT_TTL_SECONDS });
  } catch (error) {
    console.error("[another-app] audit write failed:", error instanceof Error ? error.message : error);
  }
}

// ─── mcp.ANOTHER_APP.3, .11 — rate limits ──────────────────────────────────────────────────────────────────────

export const REGISTER_POLICY = { name: "another-app-register-ip", limit: 10, windowSeconds: 3600 };
export const CONNECT_POLICY = { name: "another-app-connect-account", limit: 5, windowSeconds: 24 * 3600 };

async function take(kv: KVNamespace, key: string, p: { name: string; limit: number; windowSeconds: number }): Promise<{ allowed: boolean; status: LimitStatus }> {
  const counter = await readSlidingCounter(kv, key);
  const status = slidingStatus(counter, p.name, p.limit, p.windowSeconds);
  if (status.remaining <= 0) return { allowed: false, status };
  await writeSlidingCounter(kv, key, counter.count + 1, p.windowSeconds);
  return { allowed: true, status: { ...status, remaining: status.remaining - 1 } };
}

/** mcp.ANOTHER_APP.3 — counts one unknown-website registration from this address. */
export function takeRegistration(kv: KVNamespace, ip: string) {
  return take(kv, `rate:another-app-register:${ip}`, REGISTER_POLICY);
}

/** mcp.ANOTHER_APP.11 — counts one new unknown-website connection for this account. */
export function takeConnection(kv: KVNamespace, accountRef: string) {
  return take(kv, `rate:another-app-connect:${accountRef}`, CONNECT_POLICY);
}

// ─── mcp.ANOTHER_APP.5-8 — the gate every sign-in route runs ───────────────────────────────────────────────────

export type GateResult =
  /** A known app (or loopback / app scheme): nothing changes. */
  | { kind: "known"; request: AuthRequest }
  | { kind: "unknown"; request: AuthRequest; host: string }
  | { kind: "refused"; status: number; code: string; message: string };

export const TRUST_REQUIRED_MESSAGE = "Tick \"I know and trust this site\" first.";
export const UNAVAILABLE_MESSAGE = "This app can't connect to Kaption yet.";
export const RATE_LIMITED_MESSAGE = "Too many new apps connected today. Try again tomorrow.";

/**
 * mcp.ANOTHER_APP.6-7 — reads the signed request and, for an unknown website, checks the switch, the tick and (when
 * known) the phone. `phone` is checked only when given (send-otp, verify-otp, connect-code after peeking the code).
 */
export async function gateSignIn(
  env: { OAUTH_KV: KVNamespace; INTERNAL_API_KEY: string },
  oauthReqInfo: unknown,
  options: { trusted?: unknown; phone?: string | null } = {},
): Promise<GateResult | null> {
  const request = await readSignedRequest(oauthReqInfo, env.INTERNAL_API_KEY);
  if (!request) return null;
  const host = unknownSiteHost(request.redirectUri);
  if (!host) return { kind: "known", request };
  const policy = await loadAnotherAppPolicy(env.OAUTH_KV);
  if (!unknownSiteAllowed(host, policy) || !hasS256Pkce(request)) {
    return { kind: "refused", status: 403, code: "another_app_unavailable", message: UNAVAILABLE_MESSAGE };
  }
  if (options.trusted !== true) {
    return { kind: "refused", status: 400, code: "trust_required", message: TRUST_REQUIRED_MESSAGE };
  }
  if (options.phone !== undefined && !phoneAllowed(options.phone, policy)) {
    return { kind: "refused", status: 403, code: "another_app_unavailable", message: UNAVAILABLE_MESSAGE };
  }
  return { kind: "unknown", request, host };
}

/** mcp.ANOTHER_APP.8 — the grant metadata of an unknown website's connection. */
export function anotherAppMetadata(host: string): { anotherApp: true; destination: string } {
  return { anotherApp: true, destination: host };
}

/**
 * mcp.ANOTHER_APP.9 — a refresh of an unknown website's connection while the switch is off or the host denied:
 * refused, not revoked.
 */
export async function refreshBlocked(
  kv: KVNamespace,
  metadata: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  if (metadata?.anotherApp !== true) return false;
  const policy = await loadAnotherAppPolicy(kv);
  const host = typeof metadata.destination === "string" ? metadata.destination : "";
  return !host || !unknownSiteAllowed(host, policy);
}
