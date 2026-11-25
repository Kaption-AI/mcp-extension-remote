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
import { mergeWindows, shadowOf, sinceOf, weekRange, type LedgerPlan, type ShadowWindow, type WindowCount } from "./ledger-windows";
import { ledgerFor, type LedgerWindows, type UseRequest } from "./usage-ledger";
import { monthRange } from "./usage";
import { parseOverage, type BillMark, type CycleOverage } from "./overage";
import type { Env } from "./types";

export const READ_BATCH_MAX = 200;

export interface LedgerUsage {
  week: WindowCount | null;
  month: WindowCount | null;
  since: string | null;
  plan: (Pick<LedgerPlan, "tier" | "period" | "limit" | "pool" | "enforce" | "unit"> & { enforced_by: LedgerPlan["enforcedBy"]; fetched_at: number; since: string | null }) | null;
  shadow: { week: ShadowWindow | null; month: ShadowWindow | null };
}

const digitsOf = (v: unknown) => String(v ?? "").replace(/\D/g, "");
export const last4 = (phone: unknown) => `…${digitsOf(phone).slice(-4)}`;

/** A phone the read API accepts: 7-15 digits (a "+" or spaces are ignored). */
export function readPhone(v: unknown): string | null {
  const d = digitsOf(v);
  return typeof v === "string" && /^\d{7,15}$/.test(d) ? d : null;
}

export function validWindows(week: unknown, month: unknown, since?: unknown): { week?: string; month?: string; since?: number } | { error: string } {
  const out: { week?: string; month?: string; since?: number } = {};
  // mcp-usage-ledger.CREDITS.6 — the month window from this UTC day (ISO date or date-time).
  if (since !== undefined && since !== null && since !== "") {
    const day = sinceOf(since);
    if (day === null) return { error: "since must be an ISO date-time." };
    out.since = day;
  }
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
    w && plan && plan.period === kind ? shadowOf(plan.limit, plan.unit === "credits" ? w.credits : w.counted, crossed) : null;
  return {
    week,
    month,
    since,
    plan: plan
      ? {
          tier: plan.tier, period: plan.period, limit: plan.limit, pool: plan.pool, enforced_by: plan.enforcedBy, enforce: plan.enforce === true,
          fetched_at: plan.fetchedAt, unit: plan.unit === "credits" ? "credits" : "actions", since: plan.since ? new Date(plan.since).toISOString() : null,
        }
      : null,
    shadow: { week: shadowFor("week", week, crossedWeek), month: shadowFor("month", month, crossedMonth) },
  };
}

/** mcp-usage-ledger.READ.2-3 — the usage of one phone (both written forms of a Brazilian line). */
export async function usageForPhone(env: Env, phone: string, windows: { week?: string; month?: string; since?: number }, now = Date.now()): Promise<LedgerUsage> {
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

const ACTION_ID = /^[A-Za-z0-9_:.-]{8,96}$/;
export const USE_MAX = 1000;

/**
 * mcp-usage-ledger.SINGLE.6 — POST /internal/ledger/use's body read strictly: {phone, change reserve | refund, source
 * local | webmcp, actionIds (1-1000 ids) | count (1-1000), limit (whole number or null), enforce}. Ids are kept per road
 * (local:<id>, webmcp:<id>), as rest-api's old ledger did.
 */
export function parseUseRequest(body: Record<string, unknown>): { phone: string; change: UseRequest["change"]; use: UseRequest } | { error: string } {
  const phone = readPhone(body.phone);
  if (!phone) return { error: "phone must be 7-15 digits." };
  const change = body.change ?? "reserve";
  if (change !== "reserve" && change !== "refund") return { error: "change must be reserve or refund." };
  const source = body.source ?? "local";
  if (source !== "local" && source !== "webmcp") return { error: "source must be local or webmcp." };
  const rawIds = body.actionIds;
  let actionIds: string[] | undefined;
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > USE_MAX || !rawIds.every((a) => typeof a === "string" && ACTION_ID.test(a))) {
      return { error: `actionIds must hold 1-${USE_MAX} ids of 8-96 letters, digits, _ : . or -.` };
    }
    actionIds = (rawIds as string[]).map((a) => `${source}:${a}`);
  }
  const count = body.count ?? 1;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > USE_MAX) return { error: `count must be 1-${USE_MAX}.` };
  const limit = body.limit ?? null;
  if (limit !== null && !(Number.isInteger(limit) && (limit as number) >= 0 && (limit as number) <= 100_000)) return { error: "limit must be a whole number or null." };
  // mcp-overage-billing.LEDGER.1-2 — the window and the postpaid overage rest-api decided (absent: the week, none).
  const period = body.period ?? "week";
  if (period !== "week" && period !== "month") return { error: "period must be week or month." };
  const overage = body.overage === undefined || body.overage === null ? null : parseOverage(body.overage);
  if (body.overage && !overage) return { error: "overage must hold price_millicents, cap_millicents and anchor_ms." };
  // mcp-usage-ledger.CREDITS.6 — the unit, the since day and each reservation's credits (absent: calls, as before).
  const unit = body.unit === undefined || body.unit === null ? "actions" : body.unit;
  if (unit !== "credits" && unit !== "actions") return { error: "unit must be credits or actions." };
  const since = body.since === undefined || body.since === null || body.since === "" ? null : sinceOf(body.since);
  if (body.since && since === null) return { error: "since must be an ISO date-time." };
  const credits = body.credits ?? 1;
  if (!Number.isInteger(credits) || (credits as number) < 0 || (credits as number) > 100) return { error: "credits must be 0-100." };
  return {
    phone,
    change,
    use: {
      change, path: source, ...(actionIds ? { actionIds } : { count: count as number }), limit: limit as number | null, enforce: body.enforce === true,
      period, ...(overage ? { overage } : {}),
      ...(unit === "credits" ? { unit: "credits" as const, since, credits: credits as number } : {}),
    },
  };
}

// ─── Postpaid overage (kaptionai mcp-overage-billing.LEDGER.7-8) ─────────

/** A cycle range the overage API accepts: epoch ms, from < to, at most 32 days long. */
export function readCycle(from: unknown, to: unknown): { from: number; to: number } | null {
  const f = typeof from === "string" ? Number(from) : from;
  const t = typeof to === "string" ? Number(to) : to;
  if (!Number.isInteger(f) || !Number.isInteger(t) || (f as number) < 0 || (t as number) <= (f as number)) return null;
  if ((t as number) - (f as number) > 32 * 86_400_000) return null;
  return { from: f as number, to: t as number };
}

/** mcp-overage-billing.LEDGER.7 — one answer from the ledgers of a phone's written forms (the first form's bill mark). */
export function mergeCycles(parts: CycleOverage[]): CycleOverage {
  const [first, ...rest] = parts;
  const out = { ...first };
  for (const p of rest) {
    out.calls += p.calls;
    out.amountMc += p.amountMc;
    out.pending += p.pending;
    out.pendingMc += p.pendingMc;
    out.capMc = Math.max(out.capMc, p.capMc);
    out.carriedMc += p.carriedMc;
  }
  return out;
}

/** The JSON shape rest-api reads (snake_case, as the other internal answers). */
export function cycleJson(c: CycleOverage) {
  return {
    from: new Date(c.from).toISOString(), to: new Date(c.to).toISOString(), from_ms: c.from, to_ms: c.to,
    calls: c.calls, amount_mc: c.amountMc, pending: c.pending, pending_mc: c.pendingMc, cap_mc: c.capMc, carried_mc: c.carriedMc,
    bill: markJson(c.bill),
  };
}

export const markJson = (m: BillMark | null) =>
  m ? { state: m.state, at: new Date(m.at).toISOString(), amount_mc: m.amountMc, calls: m.calls, invoice: m.invoice } : null;
