/**
 * The ledger's internal read API (kaptionai features/mcp/mcp-usage-ledger.feature.yaml READ.2-4, SHADOW.3) — what
 * rest-api reads to answer the extension, the admin UI, the support dashboard, the Lifetime fit check and the nightly
 * comparison. Clients never call it (READ.1): it needs the internal key, which only rest-api holds.
 *
 *   GET  /internal/ledger/usage?phone=<digits>[&week=YYYY-MM-DD][&month=YYYY-MM]
 *   POST /internal/ledger/usage/batch {phones: string[1..200], week?, month?}
 *
 * Authorization: Bearer INTERNAL_API_KEY (rest-api's WRITE_API_KEY; no new secret).
 */
import { accountRefsForPhone } from "./phone-alias";
import { mergeWindows, shadowOf, weekRange, type LedgerPlan, type ShadowWindow, type WindowCount } from "./ledger-windows";
import { ledgerFor, type LedgerWindows } from "./usage-ledger";
import { monthRange } from "./usage";
import type { Env } from "./types";

export const READ_BATCH_MAX = 200;

export interface LedgerUsage {
  week: WindowCount | null;
  month: WindowCount | null;
  since: string | null;
  plan: (Omit<LedgerPlan, "enforcedBy" | "ttlSeconds"> & { enforced_by: LedgerPlan["enforcedBy"]; fetched_at: number }) | null;
  shadow: { week: ShadowWindow | null; month: ShadowWindow | null };
}

const digitsOf = (v: unknown) => String(v ?? "").replace(/\D/g, "");
export const last4 = (phone: unknown) => `…${digitsOf(phone).slice(-4)}`;

/** A phone the read API accepts: 7-15 digits (a "+" or spaces are ignored). */
export function readPhone(v: unknown): string | null {
  const d = digitsOf(v);
  return typeof v === "string" && /^\d{7,15}$/.test(d) ? d : null;
}

export function validWindows(week: unknown, month: unknown): { week?: string; month?: string } | { error: string } {
  const out: { week?: string; month?: string } = {};
  if (week !== undefined && week !== null && week !== "") {
    if (typeof week !== "string" || !weekRange(week)) return { error: "week must be a Monday, YYYY-MM-DD." };
    out.week = week;
  }
  if (month !== undefined && month !== null && month !== "") {
    if (typeof month !== "string" || !monthRange(month)) return { error: "month must be YYYY-MM." };
    out.month = month;
  }
  return out;
}

const minOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** mcp-usage-ledger.READ.3 — one answer from the ledgers of a phone's written forms (the first form's plan). */
export function mergeLedgerWindows(parts: LedgerWindows[]): LedgerUsage {
  let week: WindowCount | null = null;
  let month: WindowCount | null = null;
  let since: string | null = null;
  let crossedWeek: number | null = null;
  let crossedMonth: number | null = null;
  const plan = parts.find((p) => p.plan)?.plan ?? null;
  for (const p of parts) {
    if (p.week) week = week ? mergeWindows(week, p.week) : p.week;
    if (p.month) month = month ? mergeWindows(month, p.month) : p.month;
    if (p.since && (!since || p.since < since)) since = p.since;
    crossedWeek = minOf(crossedWeek, p.crossed.week);
    crossedMonth = minOf(crossedMonth, p.crossed.month);
  }
  // SHADOW.3 — judged against the plan's own window only; the other window has no limit.
  const shadowFor = (kind: "week" | "month", w: WindowCount | null, crossed: number | null) =>
    w && plan && plan.period === kind ? shadowOf(plan.limit, w.counted, crossed) : null;
  return {
    week,
    month,
    since,
    plan: plan
      ? { tier: plan.tier, period: plan.period, limit: plan.limit, pool: plan.pool, enforced_by: plan.enforcedBy, fetched_at: plan.fetchedAt }
      : null,
    shadow: { week: shadowFor("week", week, crossedWeek), month: shadowFor("month", month, crossedMonth) },
  };
}

/** mcp-usage-ledger.READ.2-3 — the usage of one phone (both written forms of a Brazilian line). */
export async function usageForPhone(env: Env, phone: string, windows: { week?: string; month?: string }, now = Date.now()): Promise<LedgerUsage> {
  const refs = await accountRefsForPhone(phone, env.PHONE_REF_SECRET);
  const parts = await Promise.all(refs.map((ref) => ledgerFor(env, ref).windows(windows, now) as Promise<LedgerWindows>));
  return mergeLedgerWindows(parts);
}

/** Constant-time comparison of two strings. */
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** mcp-usage-ledger.READ.2 — Bearer INTERNAL_API_KEY, nothing else. */
export function internalCaller(authorization: string | undefined, env: Pick<Env, "INTERNAL_API_KEY">): boolean {
  const auth = authorization ?? "";
  return auth.startsWith("Bearer ") && sameSecret(auth.slice(7), env.INTERNAL_API_KEY ?? "");
}
