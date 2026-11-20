/**
 * mcp-apps-cards.FLAG.1, FLAG.4 — is MCP_APPS_CARDS on for this account? The relay asks the flags worker for the
 * account's phone, like rest-api and the business-agent worker (GET /active, version 99.0.0). A failure, a timeout or an
 * odd answer counts as off (a phone already answered keeps its last answer); real answers are remembered 5 minutes.
 */
import { CARDS_FLAG } from "./cards";
import type { Env } from "./types";

export const DEFAULT_FLAGS_URL = "https://flags.kaptionai.com";
export const CARDS_FLAG_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 1_500;

const cache = new Map<string, { on: boolean; at: number }>();

/** A row of the flags worker's /active answer is on: remotely enabled (or enabled) and not remotely disabled. */
export function flagOn(payload: unknown, name: string): boolean {
  const list = payload && typeof payload === "object" ? (payload as { flags?: unknown }).flags : undefined;
  if (!Array.isArray(list)) return false;
  const row = list.find((f) => f && typeof f === "object" && (f as { name?: unknown }).name === name) as
    | { enabled?: unknown; remoteEnabled?: unknown; remoteDisabled?: unknown }
    | undefined;
  if (!row || row.remoteDisabled === true) return false;
  return row.remoteEnabled === true || row.enabled === true;
}

/**
 * MCP_APPS_CARDS for one phone. The relay's own MCP_APPS_CARDS variable must be "flags" (wrangler vars) for the flags
 * worker to be asked at all; unset, empty or "off" is off for everyone without a request (kill switch, and tests).
 */
export async function cardsOnForPhone(
  env: Pick<Env, "FLAGS_URL" | "MCP_APPS_CARDS">,
  phone: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<boolean> {
  if (String(env.MCP_APPS_CARDS ?? "").trim().toLowerCase() !== "flags") return false;
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return false;
  const hit = cache.get(digits);
  if (hit && now - hit.at < CARDS_FLAG_TTL_MS) return hit.on;
  try {
    const base = (env.FLAGS_URL || DEFAULT_FLAGS_URL).replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/active?app=KAPTION&version=99.0.0&phone=${encodeURIComponent(digits)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return hit?.on ?? false;
    const on = flagOn(await res.json(), CARDS_FLAG);
    cache.set(digits, { on, at: now });
    return on;
  } catch {
    return hit?.on ?? false;
  }
}

export function clearCardsFlagCache(): void {
  cache.clear();
}
