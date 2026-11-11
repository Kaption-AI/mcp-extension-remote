/**
 * The ledger's week and month windows, the plan it judges them against, and the shadow decision (kaptionai
 * features/mcp/mcp-usage-ledger.feature.yaml - MODEL.2-4, PLAN.1-5, SHADOW.1-3). Pure helpers: no Durable Object
 * runtime, no network (the rest-api client at the bottom takes its fetch as an argument).
 */
import { DAY_MS, dayOf, monthOf, monthRange, type UsagePath } from "./usage";
import { UNCOUNTED_TOOLS } from "./weekly-usage";
import type { Env } from "./types";

export type WindowKind = "week" | "month";

/** mcp-usage-ledger.MODEL.3 — Monday 00:00 UTC of the week holding `at`. */
export function weekStart(at: number): number {
  const day = Math.floor(at / DAY_MS) * DAY_MS;
  const dow = new Date(day).getUTCDay(); // 0 = Sunday
  return day - ((dow + 6) % 7) * DAY_MS;
}

/** The week's key: its Monday as YYYY-MM-DD (the same key rest-api's mcp_usage_week uses). */
export const weekOf = (at: number): string => dayOf(weekStart(at));

/** [from, to) of a week key (a Monday), or null when it is not one. */
export function weekRange(week: string): { from: number; to: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return null;
  const from = Date.parse(`${week}T00:00:00Z`);
  if (!Number.isFinite(from) || weekStart(from) !== from) return null;
  return { from, to: from + 7 * DAY_MS };
}

export interface WindowRange {
  kind: WindowKind;
  period: string;
  from: number;
  to: number;
}

export function windowRange(kind: WindowKind, period: string): WindowRange | null {
  const r = kind === "week" ? weekRange(period) : monthRange(period);
  return r ? { kind, period, ...r } : null;
}

export const currentWindow = (kind: WindowKind, now: number): WindowRange =>
  windowRange(kind, kind === "week" ? weekOf(now) : monthOf(now))!;

export interface WindowCount {
  period: string;
  from: string;
  to: string;
  /** mcp-usage-ledger.MODEL.2 — answered ok, uncounted tools left out, every road. */
  counted: number;
  by_source: Record<UsagePath, number>;
  refused: number;
  /** Every recorded call of the window, any outcome, uncounted tools included. */
  total: number;
}

/** One grouped daily row (LedgerStore.windowRows). */
export interface WindowRow {
  path: UsagePath;
  tool: string;
  outcome: string;
  calls: number;
}

/** mcp-usage-ledger.MODEL.2-4 — the window's numbers from its daily rows. */
export function countWindow(range: WindowRange, rows: WindowRow[]): WindowCount {
  const out: WindowCount = {
    period: range.period,
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    counted: 0,
    by_source: { cloud: 0, local: 0, webmcp: 0 },
    refused: 0,
    total: 0,
  };
  for (const r of rows) {
    out.total += r.calls;
    if (r.outcome === "refused") out.refused += r.calls;
    if (r.outcome !== "ok" || UNCOUNTED_TOOLS.has(r.tool)) continue;
    out.counted += r.calls;
    if (r.path in out.by_source) out.by_source[r.path] += r.calls;
  }
  return out;
}

/** Adds windows of two ledgers (a Brazilian line's two written forms). */
export function mergeWindows(a: WindowCount, b: WindowCount): WindowCount {
  return {
    ...a,
    counted: a.counted + b.counted,
    by_source: { cloud: a.by_source.cloud + b.by_source.cloud, local: a.by_source.local + b.by_source.local, webmcp: a.by_source.webmcp + b.by_source.webmcp },
    refused: a.refused + b.refused,
    total: a.total + b.total,
  };
}

// ─── The plan (PLAN.1-5) ───────────────────────────────────────────────

export type PlanTier = "free" | "lifetime" | "pro" | "business" | "unlimited" | "blocked";

export interface LedgerPlan {
  tier: PlanTier;
  period: WindowKind | null;
  /** null = unlimited. */
  limit: number | null;
  pool: { ref: string; numbers: number } | null;
  enforcedBy: "week_ledger" | "device" | "none";
  ttlSeconds: number;
}

export const DEFAULT_PLAN_TTL_S = 600;
const TIERS: readonly PlanTier[] = ["free", "lifetime", "pro", "business", "unlimited", "blocked"];

/** mcp-usage-ledger.PLAN.1 — rest-api's answer read defensively; null when it is not one. */
export function parsePlan(d: unknown): LedgerPlan | null {
  if (!d || typeof d !== "object") return null;
  const v = d as Record<string, unknown>;
  if (!TIERS.includes(v.tier as PlanTier)) return null;
  const period = v.period === "week" || v.period === "month" ? v.period : null;
  const limit = typeof v.limit === "number" && Number.isInteger(v.limit) && v.limit >= 0 ? v.limit : null;
  const p = v.pool as Record<string, unknown> | null | undefined;
  const pool =
    p && typeof p.ref === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(p.ref) && typeof p.numbers === "number" && p.numbers >= 1
      ? { ref: p.ref, numbers: Math.floor(p.numbers) }
      : null;
  const enforcedBy = v.enforced_by === "week_ledger" || v.enforced_by === "device" ? v.enforced_by : "none";
  const ttl = typeof v.ttl_seconds === "number" && v.ttl_seconds > 0 && v.ttl_seconds <= 86_400 ? Math.floor(v.ttl_seconds) : DEFAULT_PLAN_TTL_S;
  if (limit !== null && !period) return null;
  return { tier: v.tier as PlanTier, period, limit, pool, enforcedBy, ttlSeconds: ttl };
}

/** mcp-usage-ledger.PLAN.1, PLAN.5 — the plan from rest-api, or null when it cannot answer (the caller fails open). */
export async function fetchPlan(
  env: Pick<Env, "INTERNAL_API_BASE_URL" | "INTERNAL_API_KEY">,
  phone: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LedgerPlan | null> {
  if (!env.INTERNAL_API_BASE_URL || !env.INTERNAL_API_KEY) return null;
  try {
    const res = await fetchImpl(`${env.INTERNAL_API_BASE_URL.replace(/\/$/, "")}/__internal/mcp-ledger/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env.INTERNAL_API_KEY },
      body: JSON.stringify({ phone }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 200) return null;
    return parsePlan(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

// ─── The shadow (SHADOW.1-3) ───────────────────────────────────────────

const digitsOf = (value: unknown) => String(value ?? "").replace(/\D/g, "");

/** mcp-usage-ledger.SHADOW.1 — LEDGER_SHADOW lists this phone ("*" = everyone; "", "off" or unset = nobody). */
export function shadowPhone(phone: unknown, env: Pick<Env, "LEDGER_SHADOW">): boolean {
  const digits = digitsOf(phone);
  if (!digits) return false;
  const list = String(env.LEDGER_SHADOW ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "off");
  return list.includes("*") || list.some((entry) => digitsOf(entry) === digits);
}

export interface ShadowWindow {
  limit: number | null;
  /** Counted actions past the limit. */
  over: number;
  /** When the window's count first passed the limit (epoch ms), or null. */
  crossed_at: number | null;
}

/** mcp-usage-ledger.SHADOW.1, SHADOW.3 — what enforcing would have done to this window so far. */
export function shadowOf(limit: number | null, counted: number, crossedAt: number | null): ShadowWindow {
  if (limit === null) return { limit: null, over: 0, crossed_at: null };
  return { limit, over: Math.max(0, counted - limit), crossed_at: counted > limit ? crossedAt : null };
}

/** The plan cache is fresh until its ttl and never past the end of its window (PLAN.4). */
export function planFresh(fetchedAt: number, ttlSeconds: number, now: number, kind: WindowKind | null): boolean {
  if (now - fetchedAt >= ttlSeconds * 1000) return false;
  if (!kind) return true;
  return currentWindow(kind, fetchedAt).period === currentWindow(kind, now).period;
}
