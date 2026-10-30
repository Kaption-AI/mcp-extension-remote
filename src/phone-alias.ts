/**
 * mcp.CLOUD_RELAY.17 — one Brazilian mobile line, two ways to write it.
 *
 * Brazil added a leading 9 to every mobile number (55 + DDD + 9 + 8 digits), but WhatsApp still identifies many older
 * lines without it (55 + DDD + 8 digits), and WhatsApp delivers a message to the line whichever form is used. The relay
 * names an account by HMAC(phone), so the two forms were two accounts: someone who signed in to Claude or Codex with
 * their number as they know it (with the 9) got a connection for one account while their extension — whose Kaption
 * session carries WhatsApp's own form (without it) — waited in the other. Every call answered "Extension not
 * connected" and the app was missing from Connected apps (#2016, #10002224); typing the number without the 9 worked.
 *
 * Account references themselves are unchanged (existing connections and rooms keep their names). Instead:
 * - when the extension authenticates (it proves its phone with a Kaption JWT or session), the relay records that the
 *   other form's account lives in this room: KV `ref-alias:<other form's ref>` → `<this ref>`;
 * - a tool call whose account has no extension connected follows that alias once (RelayMCP);
 * - Connected apps lists and disconnects the connections of both forms.
 *
 * Only Brazilian mobile numbers have a second form: 55, a two-digit area code (11–99, no zero), and a subscriber
 * number starting 6–9 (with or without the 9 in front). Landlines (subscriber 2–5) and every other country have none.
 */
import { deriveAccountRef, normalizeAndValidatePhone } from "./otp";
import type { Env } from "./types";

const BR_WITH_NINE = /^55([1-9][1-9])9([6-9]\d{7})$/;
const BR_WITHOUT_NINE = /^55([1-9][1-9])([6-9]\d{7})$/;

/** Alias records outlive a long absence; every extension sign-in renews them. */
export const PHONE_ALIAS_TTL_SECONDS = 400 * 24 * 3600;

export const aliasKey = (accountRef: string) => `ref-alias:${accountRef}`;

/** The same Brazilian mobile line written the other way (with ⇄ without the 9), or null when there is none. */
export function brazilMobileVariant(phone: string): string | null {
  const normalized = normalizeAndValidatePhone(phone);
  if (!normalized) return null;
  let match = BR_WITH_NINE.exec(normalized);
  if (match) return `55${match[1]}${match[2]}`;
  match = BR_WITHOUT_NINE.exec(normalized);
  if (match) return `55${match[1]}9${match[2]}`;
  return null;
}

/** The account references of every form of this phone: its own first, then the other form's (if any). */
export async function accountRefsForPhone(phone: string, secret: string): Promise<string[]> {
  const own = await deriveAccountRef(phone, secret);
  if (!own) return [];
  const variant = brazilMobileVariant(phone);
  const other = variant ? await deriveAccountRef(variant, secret) : null;
  return other && other !== own ? [own, other] : [own];
}

/**
 * The extension proved `phone` and joined the room `roomRef`: connections made with the phone's other form find it
 * there. Written only when missing or different, so a reconnecting extension costs one KV read.
 */
export async function rememberPhoneAlias(
  kv: KVNamespace,
  phone: string,
  roomRef: string,
  secret: string,
): Promise<void> {
  const variant = brazilMobileVariant(phone);
  if (!variant) return;
  const otherRef = await deriveAccountRef(variant, secret);
  if (!otherRef || otherRef === roomRef) return;
  const key = aliasKey(otherRef);
  if ((await kv.get(key)) === roomRef) return;
  await kv.put(key, roomRef, { expirationTtl: PHONE_ALIAS_TTL_SECONDS });
}

/** The room an account's other phone form was last seen in, or null. */
export async function aliasedRoom(kv: KVNamespace, accountRef: string): Promise<string | null> {
  const value = await kv.get(aliasKey(accountRef));
  return value && value !== accountRef && value.startsWith("acct_") ? value : null;
}

const NOT_CONNECTED = /^Extension not connected/;

/**
 * A tool call for `accountRef`, sent to its room; when that room has no extension at all, once to the room its phone's
 * other form was last seen in (a connection made with the 9 while the extension signs in without it, or the reverse).
 */
export async function relayWithAlias(
  env: Pick<Env, "RELAY_ROOM" | "OAUTH_KV">,
  accountRef: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(accountRef));
  try {
    return await room.handleMcpRequest(method, params);
  } catch (err) {
    if (!(err instanceof Error) || !NOT_CONNECTED.test(err.message)) throw err;
    const alias = await aliasedRoom(env.OAUTH_KV, accountRef).catch(() => null);
    if (!alias) throw err;
    return env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(alias)).handleMcpRequest(method, params);
  }
}

/** A relayed call's error, carrying the extension's JSON-RPC code (or "offline" / "timeout") in this isolate. */
export class RelayCallError extends Error {
  constructor(message: string, readonly code: number | string | null) {
    super(message);
  }
}

/**
 * relayWithAlias through RelayRoom.handleMcpRequestSettled: the same routing (the alias is followed only when the
 * account's own room has no extension), with the error code kept (mcp-usage-accounting.RECORD.5).
 */
export async function relayWithAliasSettled(
  env: Pick<Env, "RELAY_ROOM" | "OAUTH_KV">,
  accountRef: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const call = (ref: string) => env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(ref)).handleMcpRequestSettled(method, params);
  let settled = await call(accountRef);
  if (!settled.ok && NOT_CONNECTED.test((settled as { message: string }).message)) {
    const alias = await aliasedRoom(env.OAUTH_KV, accountRef).catch(() => null);
    if (alias) settled = await call(alias);
  }
  if ("result" in settled) return settled.result;
  const failed = settled as { message: string; code: number | string | null };
  throw new RelayCallError(failed.message, failed.code);
}
