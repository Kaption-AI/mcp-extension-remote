/**
 * mcp.ANY_CLIENT — "Sign in with Kaption on this computer": any MCP app (Claude Code, Codex, Cursor, n8n, the MCP
 * Inspector, a custom app…) signs in without a phone number or a WhatsApp code, approved with one click in Kaption.
 *
 *   1. The sign-in page (this browser) creates an approval request for the OAuth request it shows
 *      (/authorize/approval/start). The request is bound to the client_id, redirect_uri and PKCE challenge, and to
 *      this browser by an HttpOnly cookie (only its SHA-256 is kept here).
 *   2. The page hands the id to the Kaption extension in the same browser (externally_connectable: only
 *      https://mcp.kaptionai.com can). The extension shows the approval in WhatsApp with what THIS module says about
 *      the request (details), never what the page claimed.
 *   3. Allow: the extension starts Kaption's silent WhatsApp handshake for the request (start, with its Kaption JWT,
 *      which names the phone but proves nothing: ACCEPT_ANY_TOKEN_BYPASS), sends "#kv3 <token> <phone>" from the
 *      user's own WhatsApp, and polls (status). Only when rest-api says the phone was PROVEN does the request become
 *      approved for that phone (the same rule as connect codes, mcp.CONNECT_CODE.2).
 *   4. The sign-in page, polling with its cookie, completes the OAuth request once (/authorize/approval/complete).
 */
import { normalizeAndValidatePhone, openState, sealState } from "./otp";
import { v3Proof, type ConnectDeps } from "./connect-code";
import { type PolicyRedirectKind } from "./redirect-policy";

export const APPROVAL_TTL_SECONDS = 300;
export const APPROVAL_COOKIE = "kaption_approval";
/** KV's shortest expirationTtl. */
const KV_MIN_TTL = 60;
const AUDIT_KEEP = 50;
const AUDIT_TTL_SECONDS = 365 * 24 * 3600;

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface ApprovalRecord {
  v: 1;
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  kind: PolicyRedirectKind;
  /** The redirect's host ("n8n.example.com"), "local" for loopback or a desktop app's scheme. */
  destination: string;
  /** Loopback: the port the app listens on; a desktop app: its scheme. */
  detail: string | null;
  /** The name the app registered with: its own claim. */
  appName: string | null;
  browserHash: string;
  /** mcp.ANY_CLIENT.18 — SHA-256 of the whole signed OAuth request (state, scope and resource included). */
  requestHash: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  /** The phone the handshake was started for (bound once). */
  phone?: string;
  sessionToken?: string;
}

/** What the extension's approval shows (mcp.ANY_CLIENT.8). */
export interface ApprovalDetails {
  status: ApprovalStatus;
  appName: string | null;
  kind: PolicyRedirectKind;
  destination: string;
  detail: string | null;
  expiresAt: number;
}

export interface AuthRequestLike {
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/** mcp.ANY_CLIENT.18 — one fingerprint for the whole OAuth request, independent of key order. */
export async function requestFingerprint(request: object): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
    }
    return value;
  };
  return sha256Hex(JSON.stringify(canonical(request)));
}

const APPROVAL_ID = /^[A-Za-z0-9_-]{32}$/;
const approvalKey = (id: string) => `approval:${id}`;
const auditKey = (accountRef: string) => `audit:approvals:${accountRef}`;

function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function isApprovalId(id: unknown): id is string {
  return typeof id === "string" && APPROVAL_ID.test(id);
}

/** mcp.ANY_CLIENT.8 — where signing in sends the person back, as the approval names it. */
export function approvalDestination(redirectUri: string, kind: PolicyRedirectKind): { destination: string; detail: string | null } {
  const url = new URL(redirectUri);
  if (kind === "loopback") return { destination: "local", detail: url.port || (url.protocol === "https:" ? "443" : "80") };
  if (kind === "app") return { destination: "local", detail: url.protocol.slice(0, -1).toLowerCase() };
  return { destination: url.host.toLowerCase(), detail: null };
}

async function save(deps: ConnectDeps, id: string, record: ApprovalRecord, now: number): Promise<void> {
  const left = Math.max(1, Math.ceil((record.expiresAt - now) / 1000));
  await deps.kv.put(approvalKey(id), await sealState(record, left, deps.secret), { expirationTtl: Math.max(KV_MIN_TTL, left) });
}

export async function readApproval(deps: ConnectDeps, id: unknown): Promise<ApprovalRecord | null> {
  if (!isApprovalId(id)) return null;
  const sealed = await deps.kv.get(approvalKey(id));
  const record = sealed ? await openState<ApprovalRecord>(sealed, deps.secret) : null;
  if (!record || record.v !== 1) return null;
  if (record.expiresAt <= (deps.now?.() ?? Date.now())) return null;
  return record;
}

/**
 * mcp.ANY_CLIENT.5 — a new approval request for this OAuth request, bound to this browser. Returns the id (for the
 * extension) and the browser secret (for the cookie).
 */
export async function createApproval(
  deps: ConnectDeps,
  input: { request: AuthRequestLike; kind: PolicyRedirectKind; appName: string | null },
): Promise<{ id: string; browserSecret: string; expiresAt: number }> {
  const { request, kind } = input;
  if (!request.clientId || !request.redirectUri) throw new Error("approval needs a client and a redirect");
  const now = deps.now?.() ?? Date.now();
  const id = randomToken(24);
  const browserSecret = randomToken(32);
  const { destination, detail } = approvalDestination(request.redirectUri, kind);
  const record: ApprovalRecord = {
    v: 1,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge ?? null,
    codeChallengeMethod: request.codeChallengeMethod ?? null,
    kind,
    destination,
    detail,
    appName: input.appName ? input.appName.slice(0, 60) : null,
    browserHash: await sha256Hex(browserSecret),
    requestHash: await requestFingerprint(request),
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_SECONDS * 1000,
    status: "pending",
  };
  await save(deps, id, record, now);
  return { id, browserSecret, expiresAt: record.expiresAt };
}

/** mcp.ANY_CLIENT.8 — what the extension shows; null when the request is gone or no longer waiting. */
export async function approvalDetails(deps: ConnectDeps, id: unknown, phone: string): Promise<ApprovalDetails | null> {
  const record = await readApproval(deps, id);
  if (!record || record.status !== "pending") return null;
  // Once bound to a phone, only that phone sees it.
  if (record.phone && record.phone !== normalizeAndValidatePhone(phone)) return null;
  return {
    status: record.status,
    appName: record.appName,
    kind: record.kind,
    destination: record.destination,
    detail: record.detail,
    expiresAt: record.expiresAt,
  };
}

export type ApprovalStartResult =
  | { ok: true; sessionToken: string }
  | { ok: false; error: "expired" | "other_account" | "invalid_phone" | "handshake_unavailable" };

/**
 * mcp.ANY_CLIENT.9 — Allow: bind the request to this phone (the JWT's) and start the WhatsApp handshake. The phone is
 * a claim until the handshake proves it.
 */
export async function startApprovalHandshake(deps: ConnectDeps, id: unknown, rawPhone: string): Promise<ApprovalStartResult> {
  const phone = normalizeAndValidatePhone(rawPhone);
  if (!phone) return { ok: false, error: "invalid_phone" };
  const record = await readApproval(deps, id);
  if (!record || record.status !== "pending") return { ok: false, error: "expired" };
  if (record.phone && record.phone !== phone) return { ok: false, error: "other_account" };
  const res = await deps.api("/api/v5/auth/v3/session", { claimedPhone: phone, clientNonce: randomToken(32) });
  const sessionToken = (res.json as { sessionToken?: unknown } | null)?.sessionToken;
  if (!res.ok || typeof sessionToken !== "string" || !sessionToken.startsWith("kv3_")) return { ok: false, error: "handshake_unavailable" };
  await save(deps, id as string, { ...record, phone, sessionToken }, deps.now?.() ?? Date.now());
  return { ok: true, sessionToken };
}

export type ApprovalPoll = { status: "pending" | "approved" | "denied" | "expired" | "unproven" | "rejected" | "needs_code" | "error" };

/**
 * mcp.ANY_CLIENT.9 — the handshake's progress. The request is approved only when the API says the phone was proven
 * (never for a link accepted on trust, a rejected or expired session).
 */
export async function pollApprovalHandshake(deps: ConnectDeps, id: unknown, rawPhone: string): Promise<ApprovalPoll> {
  const phone = normalizeAndValidatePhone(rawPhone);
  const record = await readApproval(deps, id);
  if (!record || !phone || record.phone !== phone) return { status: "expired" };
  if (record.status !== "pending") return { status: record.status };
  if (!record.sessionToken) return { status: "pending" };
  const proof = await v3Proof(deps, record.sessionToken);
  if (proof === "proven") {
    await save(deps, id as string, { ...record, status: "approved", sessionToken: undefined }, deps.now?.() ?? Date.now());
    return { status: "approved" };
  }
  if (proof === "unproven" || proof === "rejected" || proof === "expired") {
    // A failed handshake can be tried again: the request stays waiting, without that session.
    await save(deps, id as string, { ...record, sessionToken: undefined }, deps.now?.() ?? Date.now());
    return { status: proof };
  }
  return { status: proof };
}

/** mcp.ANY_CLIENT.10 — Deny. */
export async function denyApproval(deps: ConnectDeps, id: unknown, rawPhone: string): Promise<boolean> {
  const phone = normalizeAndValidatePhone(rawPhone);
  const record = await readApproval(deps, id);
  if (!record || record.status !== "pending" || !phone) return false;
  if (record.phone && record.phone !== phone) return false;
  await save(deps, id as string, { ...record, status: "denied", phone, sessionToken: undefined }, deps.now?.() ?? Date.now());
  return true;
}

async function ownedBy(record: ApprovalRecord, browserSecret: unknown): Promise<boolean> {
  if (typeof browserSecret !== "string" || browserSecret.length < 32 || browserSecret.length > 128) return false;
  return constantTimeEqual(await sha256Hex(browserSecret), record.browserHash);
}

/** mcp.ANY_CLIENT.12 — the sign-in page's poll; without this browser's cookie the request doesn't exist. */
export async function approvalStatusForBrowser(deps: ConnectDeps, id: unknown, browserSecret: unknown): Promise<ApprovalStatus | "expired"> {
  const record = await readApproval(deps, id);
  if (!record || !(await ownedBy(record, browserSecret))) return "expired";
  return record.status;
}

export type CompleteResult =
  | { ok: true; phone: string; record: ApprovalRecord }
  | { ok: false; error: "expired" | "not_approved" | "denied" | "mismatch" };

/**
 * mcp.ANY_CLIENT.11 — spend an approved request, once: this browser's, approved, for exactly this client, redirect
 * and PKCE challenge. The record is removed before the caller issues the OAuth code.
 */
export async function takeApproval(deps: ConnectDeps, id: unknown, browserSecret: unknown, request: AuthRequestLike): Promise<CompleteResult> {
  const record = await readApproval(deps, id);
  if (!record || !(await ownedBy(record, browserSecret))) return { ok: false, error: "expired" };
  if (record.status === "denied") return { ok: false, error: "denied" };
  if (record.status !== "approved" || !record.phone) return { ok: false, error: "not_approved" };
  if (
    record.clientId !== request.clientId
    || record.redirectUri !== request.redirectUri
    || record.codeChallenge !== (request.codeChallenge ?? null)
    || record.codeChallengeMethod !== (request.codeChallengeMethod ?? null)
    // mcp.ANY_CLIENT.18 — and the very request it was made for: not another state, scope or resource.
    || record.requestHash !== (await requestFingerprint(request))
  ) {
    return { ok: false, error: "mismatch" };
  }
  await deps.kv.delete(approvalKey(id as string));
  return { ok: true, phone: record.phone, record };
}

export interface AuditEntry {
  at: number;
  outcome: "approved" | "denied" | "connected";
  appName: string | null;
  clientId: string;
  destination: string;
  kind: PolicyRedirectKind;
}

/** mcp.ANY_CLIENT.13 — one log line and the account's last 50 approvals, kept a year. */
export async function recordApprovalAudit(kv: KVNamespace, accountRef: string, entry: AuditEntry): Promise<void> {
  console.log(JSON.stringify({ event: "mcp-approval", account: accountRef.slice(0, 13), ...entry }));
  try {
    const raw = await kv.get(auditKey(accountRef));
    const list = (raw ? (JSON.parse(raw) as AuditEntry[]) : []).filter(Boolean);
    list.unshift(entry);
    await kv.put(auditKey(accountRef), JSON.stringify(list.slice(0, AUDIT_KEEP)), { expirationTtl: AUDIT_TTL_SECONDS });
  } catch (e: any) {
    console.error("[approval] audit write failed:", e?.message || e);
  }
}

export async function readApprovalAudit(kv: KVNamespace, accountRef: string): Promise<AuditEntry[]> {
  try {
    const raw = await kv.get(auditKey(accountRef));
    return raw ? (JSON.parse(raw) as AuditEntry[]) : [];
  } catch {
    return [];
  }
}

/** mcp.ANY_CLIENT.5 — at most 10 approval requests per address in 10 minutes. */
export const APPROVAL_START_IP_POLICY = { name: "approval-start-ip", limit: 10, windowSeconds: 600 };
