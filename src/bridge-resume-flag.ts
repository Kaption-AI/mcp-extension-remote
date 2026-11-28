/**
 * mcp-bridge-resume.FLAG.2 (Kaption-AI monorepo features/mcp/mcp-bridge-resume.feature.yaml) — is MCP_BRIDGE_RESUME on
 * for the phone a bridge signed in with? Asked of the flags worker (GET /active, version 99.0.0) like MCP_APPS_CARDS,
 * only while the relay's MCP_BRIDGE_RESUME variable is "flags"; unset, "" or "off" is off for everyone without a
 * request (kill switch). A failure, a timeout or an odd answer is off (a phone already answered keeps its last
 * answer); real answers are remembered 5 minutes.
 */
import { DEFAULT_FLAGS_URL, flagOn } from "./cards-flag";
import type { Env } from "./types";

export const BRIDGE_RESUME_FLAG = "MCP_BRIDGE_RESUME";
export const BRIDGE_RESUME_FLAG_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 1_500;

const cache = new Map<string, { on: boolean; at: number }>();

/** mcp-bridge-resume.FLAG.2 — the relay variable allows asking at all. */
export function bridgeResumeConfigured(env: Pick<Env, "MCP_BRIDGE_RESUME">): boolean {
  return String(env.MCP_BRIDGE_RESUME ?? "").trim().toLowerCase() === "flags";
}

export async function bridgeResumeOnForPhone(
  env: Pick<Env, "FLAGS_URL" | "MCP_BRIDGE_RESUME">,
  phone: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<boolean> {
  if (!bridgeResumeConfigured(env)) return false;
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return false;
  const hit = cache.get(digits);
  if (hit && now - hit.at < BRIDGE_RESUME_FLAG_TTL_MS) return hit.on;
  try {
    const base = (env.FLAGS_URL || DEFAULT_FLAGS_URL).replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/active?app=KAPTION&version=99.0.0&phone=${encodeURIComponent(digits)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return hit?.on ?? false;
    const on = flagOn(await res.json(), BRIDGE_RESUME_FLAG);
    cache.set(digits, { on, at: now });
    return on;
  } catch {
    return hit?.on ?? false;
  }
}

export function clearBridgeResumeFlagCache(): void {
  cache.clear();
}
