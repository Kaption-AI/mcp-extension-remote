/**
 * The ledger's week and month windows, the plan it judges them against, and the shadow decision (kaptionai
 * features/mcp/mcp-usage-ledger.feature.yaml - MODEL.2-4, PLAN.1-5, SHADOW.1-3). Pure helpers: no Durable Object
 * runtime, no network (the rest-api client at the bottom takes its fetch as an argument).
 */
import { DAY_MS, dayOf, monthOf, monthRange, type UsagePath } from "./usage";
import { UNCOUNTED_TOOLS } from "./weekly-usage";
import { parseOverage, type PlanOverage } from "./overage";
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
  /**
   * mcp-usage-ledger.MODEL.2, SINGLE.2 — the window's counted actions: the answered calls recorded (uncounted tools left
   * out) plus the reservations still waiting for their record.
   */
  counted: number;
  /** The same per road (Kally's calls are in local). */
  by_source: Record<UsagePath, number>;
  /**
   * mcp-usage-ledger.SINGLE.11, KALLY_COUNT.3 — Kally's answered data calls of the window. Inside by_source.local and
   * counted only while the plan says kally_counts (KALLY_COUNTS_MCP on); otherwise recorded and shown here, never counted.
   */
  kally: number;
  /** mcp-usage-ledger.SINGLE.2 — reservations not yet recorded (already inside counted). */
  pending: number;
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
  /** A Kally (in-app) row (SINGLE.11). */
  kally?: boolean;
}

/** mcp-usage-ledger.SINGLE.2 — reservations of the window still waiting for their record, per road. */
export type PendingCounts = Partial<Record<UsagePath, number>>;

/**
 * mcp-usage-ledger.MODEL.2-4, SINGLE.2 — the window's numbers from its daily rows and its pending reservations.
 * mcp-usage-ledger.KALLY_COUNT.3-4 — Kally's rows add to the count only with `kallyCounts` (the plan's kally_counts).
 */
export function countWindow(range: WindowRange, rows: WindowRow[], pending: PendingCounts = {}, kallyCounts = false): WindowCount {
  const out: WindowCount = {
    period: range.period,
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    counted: 0,
    by_source: { cloud: 0, local: 0, webmcp: 0 },
    kally: 0,
    pending: 0,
    refused: 0,
    total: 0,
  };
  for (const r of rows) {
    out.total += r.calls;
    if (r.outcome === "refused") out.refused += r.calls;
    if (r.outcome !== "ok" || UNCOUNTED_TOOLS.has(r.tool)) continue;
    if (r.kally) {
      out.kally += r.calls;
      // mcp-usage-ledger.KALLY_COUNT.3 — flag off: recorded, never counted.
      if (!kallyCounts) continue;
    }
    if (r.path in out.by_source) out.by_source[r.path] += r.calls;
  }
  for (const path of Object.keys(out.by_source) as UsagePath[]) {
    const n = Math.max(0, Math.floor(pending[path] ?? 0));
    out.by_source[path] += n;
    out.pending += n;
  }
  out.counted = out.by_source.cloud + out.by_source.local + out.by_source.webmcp;
  return out;
}

/** Adds windows of two ledgers (a Brazilian line's two written forms). */
export function mergeWindows(a: WindowCount, b: WindowCount): WindowCount {
  return {
    ...a,
    counted: a.counted + b.counted,
    by_source: { cloud: a.by_source.cloud + b.by_source.cloud, local: a.by_source.local + b.by_source.local, webmcp: a.by_source.webmcp + b.by_source.webmcp },
    kally: (a.kally ?? 0) + (b.kally ?? 0),
    pending: (a.pending ?? 0) + (b.pending ?? 0),
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
  enforcedBy: "week_ledger" | "ledger" | "device" | "none";
  ttlSeconds: number;
  /**
   * mcp-usage-ledger.SINGLE.3 — rest-api holds this account to its weekly number today: the ledger refuses past it.
   * An older rest-api says so with enforced_by "week_ledger" (it then also refused at /access).
   */
  enforce: boolean;
  /** mcp-usage-ledger.SINGLE.3 — the refusal words rest-api wrote (the plans link inside), or null. */
  message: string | null;
  /** en | es | pt for the usage line (mcp-usage-pricing.USAGE.4), or null. */
  lang: string | null;
  /**
   * mcp-usage-ledger.KALLY_COUNT.2-3 — Kally's data calls count toward this account's number (KALLY_COUNTS_MCP on for
   * the phone). Only an explicit true; absent (older rest-api, flag off) means not counted.
   */
  kallyCounts?: boolean;
  /**
   * mcp-overage-billing.LEDGER.1-3 — the account turned postpaid overage on: past the limit its actions run and are
   * recorded as extra actions within the cap. null (or absent in an older cache): off.
   */
  overage?: PlanOverage | null;
  /** mcp-credits-simple.FLAG.2, ASK.1-7, FREE.1 — the simple extras (only with MCP_CREDITS_SIMPLE on), or null. */
  credits?: PlanCredits | null;
}

/** mcp-credits-simple — what rest-api's plan answer says the assistant is told and asks (once). */
export interface PlanCredits {
  choice: "ask" | "keep" | "stop" | "free";
  /** ASK.2, ASK.5 — hold a month plan to its allowance while asking or stopped. */
  enforce: boolean;
  askPct: number;
  priceMc: number;
  capCents: number;
  /** ASK.1 — {used} and {limit} filled here. */
  askMessage: string | null;
  stopMessage: string | null;
  upgradeMessage: string | null;
}

const CHOICES = ["ask", "keep", "stop", "free"] as const;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.slice(0, 2000) : null);

/** mcp-credits-simple.FLAG.2 — rest-api's `credits` block read defensively; null when absent or not one. */
export function parseCredits(v: unknown): PlanCredits | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!CHOICES.includes(o.choice as PlanCredits["choice"])) return null;
  const n = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : d);
  return {
    choice: o.choice as PlanCredits["choice"],
    enforce: o.enforce === true,
    askPct: n(o.ask_pct, 1, 100, 90),
    priceMc: n(o.price_millicents, 0, 1_000_000, 0),
    capCents: n(o.cap_cents, 0, 100_000, 0),
    askMessage: text(o.ask_message),
    stopMessage: text(o.stop_message),
    upgradeMessage: text(o.upgrade_message),
  };
}

/** mcp-credits-simple.ASK.1 — the question with the counts filled in. */
export const fillAsk = (template: string, used: number, limit: number) =>
  template.replace(/\{used\}/g, String(used)).replace(/\{limit\}/g, String(limit));

/**
 * mcp-credits-simple.ASK.1-2, ASK.5, FREE.1 — what the assistant reads when the account is refused at its allowance
 * (not at the overage cap): the question while asking, the US$0 words when stopped, subscribing for Free. null: none.
 */
export function creditsRefusal(credits: PlanCredits | null | undefined, used: number, limit: number): string | null {
  if (!credits) return null;
  if (credits.choice === "ask" && credits.askMessage) return fillAsk(credits.askMessage, used, limit);
  if (credits.choice === "stop") return credits.stopMessage;
  if (credits.choice === "free") return credits.upgradeMessage;
  return null;
}

/** mcp-credits-simple.ASK.1, ASK.4 — the question after a call that ran, at askPct% or more, while asking only. */
export function creditsAskLine(credits: PlanCredits | null | undefined, used: number, limit: number | null): string | null {
  if (!credits || credits.choice !== "ask" || !credits.askMessage || !limit) return null;
  return used * 100 >= limit * credits.askPct ? fillAsk(credits.askMessage, used, limit) : null;
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
  const enforcedBy = v.enforced_by === "week_ledger" || v.enforced_by === "ledger" || v.enforced_by === "device" ? v.enforced_by : "none";
  const ttl = typeof v.ttl_seconds === "number" && v.ttl_seconds > 0 && v.ttl_seconds <= 86_400 ? Math.floor(v.ttl_seconds) : DEFAULT_PLAN_TTL_S;
  if (limit !== null && !period) return null;
  // mcp-overage-billing.LEDGER.1, LEDGER.6 — postpaid overage only with a number to pass.
  const overage = limit !== null ? parseOverage(v.overage) : null;
  const credits = parseCredits(v.credits);
  // mcp-usage-ledger.SINGLE.3 — only a weekly number is enforced here (Pro and Business stay counted, SINGLE.10), unless
  // the account turned postpaid overage on (mcp-overage-billing.LEDGER.1): then its month is held to limit + cap too.
  const enforce = (v.enforce === true || enforcedBy === "week_ledger" || enforcedBy === "ledger") && limit !== null && (period === "week" || (period === "month" && (!!overage || !!credits?.enforce)));
  const message = typeof v.message === "string" && v.message.trim() ? v.message.slice(0, 2000) : null;
  const lang = v.lang === "en" || v.lang === "es" || v.lang === "pt" ? v.lang : null;
  const kallyCounts = v.kally_counts === true; // mcp-usage-ledger.KALLY_COUNT.2
  return { tier: v.tier as PlanTier, period, limit, pool, enforcedBy, ttlSeconds: ttl, enforce, message, lang, kallyCounts, overage, credits };
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
