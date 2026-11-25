/**
 * Kaption-AI monorepo specs: features/mcp/mcp-usage-ledger.feature.yaml (SINGLE.1-15) and
 * features/mcp/mcp-usage-pricing.feature.yaml (USAGE.1-8).
 *
 * Claude/ChatGPT usage is counted and enforced in one place, the account's UsageLedger (usage-ledger.ts): every cloud
 * call is recorded there, and an account rest-api holds to a weekly number (its /__internal/mcp-ledger/plan answer says
 * enforce) has each cloud call reserved there before it runs and refused past the number (SINGLE.4). rest-api's
 * weekly ledger (mcp_usage_week) is no longer asked or written, and WEEKLY_PLAN_LIMITS_PHONES is no longer read
 * (SINGLE.15).
 *
 * MCP_USAGE_IN_RESULTS ("on" or "*" = everyone, else a comma list): the tool result says what is left, from the
 * ledger's own week or month - in _meta.kaption.usage, the X-Kaption-Usage-* headers and, when little is left, one short
 * localized line.
 */
import type { Env } from "./types";
import type { LedgerPlan, WindowCount } from "./ledger-windows";

/** mcp-usage-pricing.PRICE.1 — tools that are never counted (settings, help, plans, Business Agent). */
export const UNCOUNTED_TOOLS: ReadonlySet<string> = new Set([
  "get_api_info", "kaption_help", "get_kaption_settings", "update_kaption_settings", "reconnect_kaption_connection",
  "report_bug", "kaption_plans", "create_kaption_checkout_link", "get_business_agent", "manage_business_agent",
  "kaption_settings", "business_agent",
]);

const digitsOf = (value: unknown) => String(value ?? "").replace(/\D/g, "");

function listed(phone: unknown, raw: string | undefined, allWords: string[] = ["*"]): boolean {
  const digits = digitsOf(phone);
  if (!digits) return false;
  const list = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.some((e) => allWords.includes(e)) || list.some((entry) => digitsOf(entry) === digits);
}

/** mcp-usage-pricing.USAGE.8 — the relay shows what is left for this phone. */
export const usagePhone = (phone: unknown, env: Pick<Env, "MCP_USAGE_IN_RESULTS">) => listed(phone, env.MCP_USAGE_IN_RESULTS, ["*", "on"]);
/** The usage switch set at all (a session with it unset never looks its phone up for usage). */
export const usageConfigured = (env: Pick<Env, "MCP_USAGE_IN_RESULTS">) =>
  String(env.MCP_USAGE_IN_RESULTS ?? "").split(",").some((s) => s.trim() && s.trim() !== "off");

// ---------------------------------------------------------------------------------------------------------------------
// Copied verbatim from the monorepo's shared rules (kext/src/core/pricing/weeklyPlanLimits.ts, credits wording of owner 2026-11-25); the fixture's
// usage section is replayed in weekly-usage.test.ts. Change it there first, then here.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** mcp-usage-pricing.USAGE_IN_RESULTS.1 — money in whole US cents. */
export interface McpUsageOverage { enabled: boolean; spent: number; cap: number | null; balance: number | null }
/** mcp-usage-pricing.USAGE_IN_RESULTS.1 — limit and left null: unlimited. */
export interface McpUsage {
  period: 'week' | 'month';
  used: number;
  limit: number | null;
  left: number | null;
  resetsAt: string;
  source: 'ledger' | 'device';
  overage: McpUsageOverage | null;
}

const wholeN = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const intN = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** mcp-usage-pricing.USAGE_IN_RESULTS.1 — a usage object read defensively; null when it is not one. */
export function normalizeUsage(value: unknown): McpUsage | null {
  if (!isObj(value)) return null;
  const period = value.period === 'week' || value.period === 'month' ? value.period : null;
  if (!period) return null;
  const used = wholeN(value.used) ?? 0;
  const limit = wholeN(value.limit);
  const left = limit === null ? null : Math.min(limit, wholeN(value.left) ?? Math.max(0, limit - used));
  const o = value.overage;
  const overage: McpUsageOverage | null = isObj(o)
    ? { enabled: o.enabled === true, spent: wholeN(o.spent) ?? 0, cap: wholeN(o.cap), balance: intN(o.balance) }
    : null;
  return {
    period, used, limit, left,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : '',
    source: value.source === 'ledger' ? 'ledger' : 'device',
    overage,
  };
}

/** mcp-usage-pricing.USAGE_IN_RESULTS.2 — what a tool result carries under `_meta` ({kaption:{usage}}); null: nothing. */
export function usageMeta(usage: unknown): { kaption: { usage: McpUsage } } | null {
  const u = normalizeUsage(usage);
  return u ? { kaption: { usage: u } } : null;
}

/** mcp-usage-pricing.USAGE_IN_RESULTS.3 — en, es or pt from an account language ('pt-BR' → pt); anything else en. */
export function usageLang(lang: unknown): 'en' | 'es' | 'pt' {
  const l = typeof lang === 'string' ? lang.trim().toLowerCase().slice(0, 2) : '';
  return l === 'es' || l === 'pt' ? l : 'en';
}

/** US cents as "$1.20" / "$10" (en) or "US$1,20" / "US$10" (es, pt). */
function money(cents: number, lang: 'en' | 'es' | 'pt'): string {
  const whole = cents % 100 === 0;
  const text = whole ? String(cents / 100) : (cents / 100).toFixed(2);
  return lang === 'en' ? `$${text}` : `US$${text.replace('.', ',')}`;
}

/**
 * mcp-usage-pricing.USAGE_IN_RESULTS.3 — the short line appended to a tool's text: only when 20% or less of the limit is
 * left, or extra actions were paid for (overage.spent > 0, which wins); null otherwise or for an unlimited plan.
 */
export function usageLine(usage: unknown, lang: unknown): string | null {
  const u = normalizeUsage(usage);
  if (!u) return null;
  const l = usageLang(lang);
  const week = u.period === 'week';
  if (u.overage && u.overage.spent > 0) {
    const spent = money(u.overage.spent, l);
    const cap = u.overage.cap === null ? null : money(u.overage.cap, l);
    if (l === 'es') {
      const past = u.limit === null ? 'Kaption: créditos extra de Claude y ChatGPT' : `Kaption: superaste los ${u.limit} créditos ${week ? 'de esta semana' : 'de este mes'}`;
      return cap ? `${past}; usaste ${spent} de tus ${cap}.` : `${past}; usaste ${spent}.`;
    }
    if (l === 'pt') {
      const past = u.limit === null ? 'Kaption: créditos extras do Claude e ChatGPT' : `Kaption: você passou dos ${u.limit} créditos ${week ? 'desta semana' : 'deste mês'}`;
      return cap ? `${past}; usou ${spent} dos seus ${cap}.` : `${past}; usou ${spent}.`;
    }
    const past = u.limit === null ? 'Kaption: extra Claude and ChatGPT credits' : `Kaption: past ${week ? "this week's" : "this month's"} ${u.limit} credits`;
    return cap ? `${past}; ${spent} of your ${cap} used.` : `${past}; ${spent} used.`;
  }
  if (u.limit === null || u.left === null || u.limit === 0) return null;
  if (u.left > u.limit * 0.2) return null;
  if (l === 'es') {
    return `Kaption: ${u.left === 1 ? 'queda' : 'quedan'} ${u.left} de ${u.limit} créditos de Claude y ChatGPT ${week ? 'esta semana (se renueva el lunes)' : 'este mes (se renueva el día 1)'}.`;
  }
  if (l === 'pt') {
    return `Kaption: ${u.left === 1 ? 'resta' : 'restam'} ${u.left} de ${u.limit} créditos do Claude e ChatGPT ${week ? 'nesta semana (renova na segunda-feira)' : 'neste mês (renova no dia 1)'}.`;
  }
  return `Kaption: ${u.left} of ${u.limit} Claude and ChatGPT credits left ${week ? 'this week (resets Monday)' : 'this month (resets on the 1st)'}.`;
}

// ---------------------------------------------------------------------------------------------------------------------

export type Usage = McpUsage;
export type UsageLang = "en" | "es" | "pt";

/** mcp-usage-pricing.USAGE.6 — the response headers (a header omitted when its value is null or empty). */
export function usageHeaders(usage: Usage): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: string, v: string | number | null | undefined) => {
    if (v !== null && v !== undefined && v !== "") out[name] = String(v);
  };
  put("X-Kaption-Usage-Period", usage.period);
  put("X-Kaption-Usage-Used", usage.used);
  put("X-Kaption-Usage-Limit", usage.limit);
  put("X-Kaption-Usage-Left", usage.left);
  put("X-Kaption-Usage-Resets", usage.resetsAt);
  put("X-Kaption-Overage-Spent", usage.overage?.spent);
  put("X-Kaption-Overage-Cap", usage.overage?.cap);
  put("X-Kaption-Overage-Balance", usage.overage?.balance);
  return out;
}

/** mcp-usage-ledger.SINGLE.4 — the refusal words when rest-api's plan answer carried none. */
export function refusalFallback(limit: number, period: "week" | "month" | null = "week", unit: "credits" | "actions" = "actions"): string {
  // mcp-usage-ledger.CREDITS.8 — a credits month says so.
  if (period === "month") {
    return `This Kaption account has used this month's ${limit} Claude and ChatGPT ${unit}. Tell the user they come back on the 1st, or to choose a plan at https://kaptionai.com/pricing for more.`;
  }
  return `This Kaption account has used this week's ${limit} Claude and ChatGPT ${unit}. Tell the user they come back on Monday, or to choose a plan at https://kaptionai.com/pricing for more.`;
}

/**
 * mcp-usage-pricing.USAGE.1-3, mcp-usage-ledger.SINGLE.2 — what is left, from the ledger: the plan's window (week for
 * free and lifetime, month for Pro and Business) and its counted actions; null without a plan. Overage stays null (the
 * overage switches are off, mcp-usage-ledger.OVERAGE.7).
 */
export function ledgerUsage(plan: LedgerPlan | null, window: (Pick<WindowCount, "counted" | "to"> & { credits?: number }) | null): Usage | null {
  if (!plan || !window) return null;
  // mcp-usage-ledger.CREDITS.5 — a credits plan shows credits.
  const used = Math.max(0, plan.unit === "credits" ? window.credits ?? window.counted : window.counted);
  const limit = plan.limit;
  return {
    period: plan.period === "month" ? "month" : "week",
    used,
    limit,
    left: limit === null ? null : Math.max(0, limit - used),
    resetsAt: window.to,
    source: "ledger",
    overage: null,
  };
}

/** mcp-usage-pricing.USAGE.6 — the usage a JSON-RPC tool result carries in _meta.kaption.usage, or null. */
export function usageFromJsonRpc(body: unknown): Usage | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages as any[]) {
    const u = normalizeUsage(m?.result?._meta?.kaption?.usage);
    if (u) return u;
  }
  return null;
}

/**
 * mcp-usage-pricing.USAGE.6, USAGE.8 — adds the X-Kaption-Usage-* headers to a JSON /mcp response whose tool result
 * carries usage. Anything else (SSE streams, no usage, a parse failure) is returned untouched.
 */
export async function withUsageHeaders(response: Response, env: Pick<Env, "MCP_USAGE_IN_RESULTS">): Promise<Response> {
  if (!String(env.MCP_USAGE_IN_RESULTS ?? "").trim() || String(env.MCP_USAGE_IN_RESULTS).trim() === "off") return response;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  try {
    const usage = usageFromJsonRpc(await response.clone().json());
    if (!usage) return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(usageHeaders(usage))) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}
