/**
 * mcp.CONNECT_CODE — "Add to Claude": a short code that stands in for the phone number on the sign-in page.
 *
 * The Kaption extension asks for a code (with its Kaption JWT, which only keeps strangers from spending our API
 * calls). The connector then starts Kaption's silent WhatsApp handshake for that phone (rest-api auth v3): the
 * extension sends "#kv3 <token> <phone>" from the user's own WhatsApp, and Kaption's bot checks it. Only when the
 * API says the phone was PROVEN (auth-v3-server.PROVEN — Meta's phone on the webhook, or the code round-trip; never a
 * link accepted on trust) does the connector mint a code: 8 characters, single use, 10 minutes. Pasted on the sign-in
 * page (or remembered there by the /connect page), it signs in as that phone without typing it or a WhatsApp code.
 *
 * The extension's JWT is not the proof: the API can still mint one for any phone (ACCEPT_ANY_TOKEN_BYPASS).
 */
import { normalizeAndValidatePhone, openState, sealState } from "./otp";
import type { Env } from "./types";

export const CONNECT_CODE_TTL_SECONDS = 600;
const PAIR_TTL_SECONDS = 600;
/** No 0/O, 1/I/L: read aloud or copied by hand, nothing looks like something else. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
export const CONNECT_COOKIE = "kaption_connect";

export interface ConnectDeps {
  kv: KVNamespace;
  secret: string;
  /** POST to Kaption's API (rest-api), JSON in and out. */
  api: (path: string, body: unknown) => Promise<{ ok: boolean; status: number; json: unknown }>;
  now?: () => number;
}

interface PairRecord {
  sessionToken: string;
  phone: string;
  code?: string;
  codeExpiresAt?: number;
}

interface CodeRecord {
  phone: string;
}

export type PairStatus =
  | { status: "pending" }
  | { status: "ready"; code: string; expiresAt: number; masked: string }
  | { status: "unproven" | "needs_code" | "rejected" | "expired" | "error" };

function randomToken(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** mcp.CONNECT_CODE.3 — 8 characters from a 31-letter alphabet (about 8.5 × 10^11 codes), unbiased. */
export function generateConnectCode(): string {
  const limit = 256 - (256 % ALPHABET.length);
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && code.length < CODE_LENGTH) code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return code;
}

/** What a person pasted, as a code: any case, spaces and dashes ignored; null when it can't be one. */
export function normalizeConnectCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s\-_.]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

export function formatConnectCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The phone as the sign-in page shows it: its country part and last four digits. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "•••";
  return `+${digits.slice(0, digits.length > 11 ? 2 : 1)} ••• ${digits.slice(-4)}`;
}

const pairKey = (pairId: string) => `connect-pair:${pairId}`;
const codeKey = (code: string) => `connect-code:${code}`;

/** mcp.CONNECT_CODE.1 — start the WhatsApp handshake for this phone; the extension sends the message. */
export async function startConnectPairing(deps: ConnectDeps, rawPhone: string): Promise<{ pairId: string; sessionToken: string } | null> {
  const phone = normalizeAndValidatePhone(rawPhone);
  if (!phone) return null;
  const res = await deps.api("/api/v5/auth/v3/session", { claimedPhone: phone, clientNonce: randomToken(32) });
  const sessionToken = (res.json as { sessionToken?: unknown } | null)?.sessionToken;
  if (!res.ok || typeof sessionToken !== "string" || !sessionToken.startsWith("kv3_")) return null;
  const pairId = randomToken();
  const record: PairRecord = { sessionToken, phone };
  await deps.kv.put(pairKey(pairId), await sealState(record, PAIR_TTL_SECONDS, deps.secret), { expirationTtl: PAIR_TTL_SECONDS });
  return { pairId, sessionToken };
}

async function readPair(deps: ConnectDeps, pairId: string): Promise<PairRecord | null> {
  if (typeof pairId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(pairId)) return null;
  const sealed = await deps.kv.get(pairKey(pairId));
  return sealed ? openState<PairRecord>(sealed, deps.secret) : null;
}

/**
 * mcp.CONNECT_CODE.2 — the handshake's progress. `phone` must be the caller's own (from its JWT). A code is minted
 * once the API says the phone was proven, and the same code is returned to later polls.
 */
export async function pollConnectPairing(deps: ConnectDeps, pairId: string, phone: string): Promise<PairStatus> {
  const pair = await readPair(deps, pairId);
  if (!pair || pair.phone !== normalizeAndValidatePhone(phone)) return { status: "expired" };
  const now = deps.now?.() ?? Date.now();
  if (pair.code && pair.codeExpiresAt && pair.codeExpiresAt > now) {
    return { status: "ready", code: formatConnectCode(pair.code), expiresAt: pair.codeExpiresAt, masked: maskPhone(pair.phone) };
  }
  const res = await deps.api("/api/v5/auth/v3/status", { sessionToken: pair.sessionToken });
  if (!res.ok) return { status: "error" };
  const body = (res.json ?? {}) as { confirmed?: boolean; proven?: boolean; reason?: string };
  if (!body.confirmed) {
    if (body.reason === "needs_code" || body.reason === "rejected" || body.reason === "expired") {
      if (body.reason !== "needs_code") await deps.kv.delete(pairKey(pairId));
      return { status: body.reason };
    }
    return { status: "pending" };
  }
  // mcp.CONNECT_CODE.2 — accepted is not proven: a link taken on trust never becomes a code.
  if (body.proven !== true) {
    await deps.kv.delete(pairKey(pairId));
    return { status: "unproven" };
  }
  const code = generateConnectCode();
  const expiresAt = now + CONNECT_CODE_TTL_SECONDS * 1000;
  const record: CodeRecord = { phone: pair.phone };
  await deps.kv.put(codeKey(code), await sealState(record, CONNECT_CODE_TTL_SECONDS, deps.secret), { expirationTtl: CONNECT_CODE_TTL_SECONDS });
  const updated: PairRecord = { ...pair, code, codeExpiresAt: expiresAt };
  await deps.kv.put(pairKey(pairId), await sealState(updated, PAIR_TTL_SECONDS, deps.secret), { expirationTtl: PAIR_TTL_SECONDS });
  return { status: "ready", code: formatConnectCode(code), expiresAt, masked: maskPhone(pair.phone) };
}

/** mcp.CONNECT_CODE.4 — the phone behind a code, without spending it (the sign-in page's masked prefill). */
export async function peekConnectCode(deps: ConnectDeps, input: unknown): Promise<string | null> {
  const code = normalizeConnectCode(input);
  if (!code) return null;
  const sealed = await deps.kv.get(codeKey(code));
  const record = sealed ? await openState<CodeRecord>(sealed, deps.secret) : null;
  return record ? normalizeAndValidatePhone(record.phone) : null;
}

/** mcp.CONNECT_CODE.3 — spend a code: its phone, once. */
export async function redeemConnectCode(deps: ConnectDeps, input: unknown): Promise<string | null> {
  const phone = await peekConnectCode(deps, input);
  if (!phone) return null;
  await deps.kv.delete(codeKey(normalizeConnectCode(input)!));
  return phone;
}

/** mcp.CONNECT_CODE.6 — a person guessing codes: at most 20 wrong ones per address in 10 minutes. */
export async function redeemAllowed(kv: KVNamespace, ip: string): Promise<boolean> {
  const count = Number((await kv.get(`rate:connect-redeem:${ip}`)) ?? "0");
  return count < 20;
}

export async function countFailedRedeem(kv: KVNamespace, ip: string): Promise<void> {
  const key = `rate:connect-redeem:${ip}`;
  const count = Number((await kv.get(key)) ?? "0");
  await kv.put(key, String(count + 1), { expirationTtl: 600 });
}

/** mcp.CONNECT_CODE.6 — at most 10 handshakes per phone an hour. */
export async function startAllowed(kv: KVNamespace, accountRef: string): Promise<boolean> {
  const key = `rate:connect-start:${accountRef}`;
  const count = Number((await kv.get(key)) ?? "0");
  if (count >= 10) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

/** Kaption's API (rest-api) for the handshake: POST, JSON in and out. */
export function kaptionApi(baseUrl: string): ConnectDeps["api"] {
  const base = baseUrl.replace(/\/$/, "");
  return async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "kaption-mcp-remote" },
      body: JSON.stringify(body),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, json };
  };
}

export function connectDeps(env: Pick<Env, "OAUTH_KV" | "EPHEMERAL_STATE_SECRET" | "INTERNAL_API_BASE_URL">): ConnectDeps {
  return { kv: env.OAUTH_KV, secret: env.EPHEMERAL_STATE_SECRET, api: kaptionApi(env.INTERNAL_API_BASE_URL) };
}
