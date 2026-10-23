/**
 * Rate-limit state and its HTTP headers (AgentReady AR-ACT-02).
 *
 * Only limits the relay really counts get headers; nothing here invents one.
 * Headers follow the IETF httpapi RateLimit fields as most clients read them:
 *   RateLimit-Limit      the quota of the most restrictive policy that applies
 *   RateLimit-Remaining  what is left of it after this request
 *   RateLimit-Reset      seconds until it is restored
 *   RateLimit-Policy     every applying policy, "<limit>;w=<window seconds>"
 * A 429 also carries Retry-After (seconds) and a problem+json body
 * (src/problem.ts) with code "rate_limited" and the policy name.
 */

import { problem } from "./problem";
import type { RateLimitRecord } from "./types";

export interface LimitStatus {
  /** Stable policy name, e.g. "otp-send-account". */
  policy: string;
  limit: number;
  windowSeconds: number;
  /** Requests still allowed before this one is counted. */
  remaining: number;
  /** Seconds until the counter resets (an upper bound for sliding counters). */
  resetSeconds: number;
}

function clampSeconds(ms: number, windowSeconds: number): number {
  return Math.min(windowSeconds, Math.max(1, Math.ceil(ms / 1000)));
}

/**
 * State of a fixed window stored as `{count, windowStart}` JSON (the OTP
 * counters in otp.ts). A missing or elapsed window is a fresh one.
 */
export function fixedWindowStatus(
  raw: string | null,
  policy: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): LimitStatus {
  const fresh = { policy, limit, windowSeconds, remaining: limit, resetSeconds: windowSeconds };
  if (!raw) return fresh;
  let record: RateLimitRecord;
  try {
    record = JSON.parse(raw) as RateLimitRecord;
  } catch {
    return fresh;
  }
  const elapsed = now - record.windowStart;
  if (!(elapsed >= 0) || elapsed > windowSeconds * 1000) return fresh;
  return {
    policy,
    limit,
    windowSeconds,
    remaining: Math.max(0, limit - (Number(record.count) || 0)),
    resetSeconds: clampSeconds(windowSeconds * 1000 - elapsed, windowSeconds),
  };
}

/**
 * A counter stored as a plain number whose TTL restarts on every write (the
 * connect-code and reviewer counters). The value format is unchanged so a
 * worker version still running the old code reads it the same; the moment it
 * expires rides along as KV metadata, read in the same KV operation. Without
 * metadata (written before this change) the full window is the honest bound.
 */
export async function readSlidingCounter(
  kv: KVNamespace,
  key: string,
  now = Date.now(),
): Promise<{ count: number; expiresAt: number | null }> {
  if (typeof (kv as Partial<KVNamespace>).getWithMetadata === "function") {
    const { value, metadata } = await kv.getWithMetadata<{ expiresAt?: number }>(key);
    const expiresAt = typeof metadata?.expiresAt === "number" && metadata.expiresAt > now ? metadata.expiresAt : null;
    return { count: Number(value ?? "0") || 0, expiresAt };
  }
  return { count: Number((await kv.get(key)) ?? "0") || 0, expiresAt: null };
}

export async function writeSlidingCounter(
  kv: KVNamespace,
  key: string,
  count: number,
  ttlSeconds: number,
  now = Date.now(),
): Promise<void> {
  await kv.put(key, String(count), {
    expirationTtl: ttlSeconds,
    metadata: { expiresAt: now + ttlSeconds * 1000 },
  });
}

export function slidingStatus(
  counter: { count: number; expiresAt: number | null },
  policy: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): LimitStatus {
  if (counter.count <= 0) return { policy, limit, windowSeconds, remaining: limit, resetSeconds: windowSeconds };
  return {
    policy,
    limit,
    windowSeconds,
    remaining: Math.max(0, limit - counter.count),
    resetSeconds: counter.expiresAt ? clampSeconds(counter.expiresAt - now, windowSeconds) : windowSeconds,
  };
}

/** The status after this request was counted against it. */
export function consumed(status: LimitStatus): LimitStatus {
  const remaining = Math.max(0, status.remaining - 1);
  // A request opening a new window starts it now.
  const resetSeconds = status.remaining === status.limit ? status.windowSeconds : status.resetSeconds;
  return { ...status, remaining, resetSeconds };
}

/** The policy closest to running out (ties: the one resetting last). */
export function mostRestrictive(...statuses: LimitStatus[]): LimitStatus {
  return statuses.reduce((a, b) =>
    b.remaining < a.remaining || (b.remaining === a.remaining && b.resetSeconds > a.resetSeconds) ? b : a,
  );
}

export function rateLimitHeaders(...statuses: LimitStatus[]): Record<string, string> {
  if (!statuses.length) return {};
  const top = mostRestrictive(...statuses);
  return {
    "RateLimit-Limit": String(top.limit),
    "RateLimit-Remaining": String(top.remaining),
    "RateLimit-Reset": String(top.resetSeconds),
    "RateLimit-Policy": statuses.map((s) => `${s.limit};w=${s.windowSeconds}`).join(", "),
  };
}

/**
 * 429 for an exhausted policy: Retry-After and RateLimit-* headers, and a
 * problem body. `extra` keeps fields pages already read (error, errorKey…).
 */
export function tooManyRequests(
  status: LimitStatus,
  detail: string,
  init: { headers?: HeadersInit; extra?: Record<string, unknown> } = {},
): Response {
  const headers = new Headers(init.headers);
  const exhausted = { ...status, remaining: 0 };
  for (const [key, value] of Object.entries(rateLimitHeaders(exhausted))) headers.set(key, value);
  headers.set("Retry-After", String(exhausted.resetSeconds));
  return problem({
    status: 429,
    code: "rate_limited",
    detail,
    headers,
    extra: { ...(init.extra ?? {}), policy: status.policy, retry_after: exhausted.resetSeconds },
  });
}
