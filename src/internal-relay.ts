/**
 * mcp.CLOUD_RELAY.18 — the relay's internal entrypoint for other Kaption workers on the same Cloudflare account.
 *
 * Reachable only through a Cloudflare service binding that names this entrypoint
 * (`{ service: "mcp-remote", entrypoint: "InternalRelay" }`). It has no route: the public fetch handler never
 * dispatches to it, so nothing on the internet can call it.
 *
 * The business-agent worker needs the account reference of a phone it already verified (a Kaption session JWT, a
 * rest-api record) to reach the relay room the user's extension or desktop app joined. That reference is
 * HMAC(PHONE_REF_SECRET, phone digits); keeping the derivation here means PHONE_REF_SECRET never leaves this worker.
 *
 * Brazilian numbers (mcp.CLOUD_RELAY.17): references are per written form, exactly as deriveAccountRef names a room;
 * the reference returned is the given form's own, never the other form's, so a caller's records stay stable. The
 * caller passes the form Kaption's own records carry (the session's phone), which is the form the extension signs in
 * with and so names the room the extension is in.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { deriveAccountRef, normalizeAndValidatePhone } from "./otp";
import type { Env } from "./types";

/** E.164 as a caller sends it: an optional "+" and 8–15 digits, nothing else (no spaces, dashes or letters). */
const E164 = /^\+?\d{8,15}$/;

/** mcp.CLOUD_RELAY.18 — the phone's digits when it is a valid E.164 number, otherwise null. */
export function e164Digits(phone: unknown): string | null {
  if (typeof phone !== "string" || !E164.test(phone)) return null;
  return normalizeAndValidatePhone(phone);
}

/** mcp.CLOUD_RELAY.18 — the account reference (relay room name) of a verified phone, or null for an invalid one. */
export async function accountRefForPhone(phone: unknown, secret: string): Promise<string | null> {
  const digits = e164Digits(phone);
  if (!digits || !secret) return null;
  return deriveAccountRef(digits, secret);
}

export class InternalRelay extends WorkerEntrypoint<Env> {
  /**
   * mcp.CLOUD_RELAY.18 — `acct_…` for this phone, or null when it is not an E.164 number. The caller must already
   * have verified the phone belongs to the user; this method only names the room.
   */
  async accountRefForPhone(phone: string): Promise<string | null> {
    return accountRefForPhone(phone, this.env.PHONE_REF_SECRET);
  }
}
