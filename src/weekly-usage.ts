/**
 * Kaption-AI monorepo specs: features/pricing/weekly-plan-limits.feature.yaml (SERVER.9, SERVER.13, COUNT.10) and
 * features/mcp/mcp-usage-pricing.feature.yaml (USAGE.1-8).
 *
 * Two switches, both off by default (unset = nobody, every call and every response exactly as before):
 *   - WEEKLY_PLAN_LIMITS_PHONES ("*" = everyone, else a comma list of phones): each cloud tool call of a listed phone is
 *     counted on rest-api's weekly ledger before it runs (POST /__internal/mcp-ledger/use {phone, change, actionId}),
 *     refused at the limit (402 weekly-limit-reached, the plans link in the text) and given back when it fails.
 *     rest-api's own switch (its WEEKLY_PLAN_LIMITS_PHONES + the WEEKLY_PLAN_LIMITS flag) still decides; when rest-api
 *     cannot answer, the call runs (disabled-gating.MCP.5).
 *   - MCP_USAGE_IN_RESULTS ("on" or "*" = everyone, else a comma list): the relay asks for `usage` (body usage: true) and
 *     puts it in the tool result's _meta.kaption.usage, in the X-Kaption-Usage-* headers (JSON responses) and, when
 *     little is left or overage is active, in one short localized line. rest-api answers usage only with the
 *     MCP_USAGE_IN_RESULTS flag on for the phone.
 */
import type { Env } from "./types";

/** mcp-usage-pricing.PRICE.1 — tools that are never counted (settings, help, plans, Business Agent). */
export const UNCOUNTED_TOOLS: ReadonlySet<string> = new Set([
  "get_api_info", "kaption_help", "get_kaption_settings", "update_kaption_settings", "reconnect_kaption_connection",
  "report_bug", "kaption_plans", "create_kaption_checkout_link", "get_business_agent", "manage_business_agent",
  "kaption_settings", "business_agent",
]);

type UsageEnv = Pick<Env, "INTERNAL_API_BASE_URL" | "INTERNAL_API_KEY" | "WEEKLY_PLAN_LIMITS_PHONES" | "MCP_USAGE_IN_RESULTS">;

const digitsOf = (value: unknown) => String(value ?? "").replace(/\D/g, "");

function listed(phone: unknown, raw: string | undefined, allWords: string[] = ["*"]): boolean {
  const digits = digitsOf(phone);
  if (!digits) return false;
  const list = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.some((e) => allWords.includes(e)) || list.some((entry) => digitsOf(entry) === digits);
}

/** weekly-plan-limits.SERVER.13 — the relay counts this phone's calls on the weekly ledger. */
export const weeklyPhone = (phone: unknown, env: Pick<Env, "WEEKLY_PLAN_LIMITS_PHONES">) => listed(phone, env.WEEKLY_PLAN_LIMITS_PHONES);
/** mcp-usage-pricing.USAGE.8 — the relay shows what is left for this phone. */
export const usagePhone = (phone: unknown, env: Pick<Env, "MCP_USAGE_IN_RESULTS">) => listed(phone, env.MCP_USAGE_IN_RESULTS, ["*", "on"]);
/** Either switch set at all (a session with both unset never looks its phone up). */
export const usageConfigured = (env: Pick<Env, "WEEKLY_PLAN_LIMITS_PHONES" | "MCP_USAGE_IN_RESULTS">) =>
  [env.WEEKLY_PLAN_LIMITS_PHONES, env.MCP_USAGE_IN_RESULTS].some((v) => String(v ?? "").split(",").some((s) => s.trim() && s.trim() !== "off"));

// ---------------------------------------------------------------------------------------------------------------------
// Copied verbatim from the monorepo's shared rules (kext/src/core/pricing/weeklyPlanLimits.ts at 44a6ef1a1); the fixture's
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
      const past = u.limit === null ? 'Kaption: acciones extra de Claude y ChatGPT' : `Kaption: superaste las ${u.limit} acciones ${week ? 'de esta semana' : 'de este mes'}`;
      return cap ? `${past}; usaste ${spent} de tus ${cap}.` : `${past}; usaste ${spent}.`;
    }
    if (l === 'pt') {
      const past = u.limit === null ? 'Kaption: ações extras do Claude e ChatGPT' : `Kaption: você passou das ${u.limit} ações ${week ? 'desta semana' : 'deste mês'}`;
      return cap ? `${past}; usou ${spent} dos seus ${cap}.` : `${past}; usou ${spent}.`;
    }
    const past = u.limit === null ? 'Kaption: extra Claude and ChatGPT actions' : `Kaption: past ${week ? "this week's" : "this month's"} ${u.limit} actions`;
    return cap ? `${past}; ${spent} of your ${cap} used.` : `${past}; ${spent} used.`;
  }
  if (u.limit === null || u.left === null || u.limit === 0) return null;
  if (u.left > u.limit * 0.2) return null;
  if (l === 'es') {
    return `Kaption: ${u.left === 1 ? 'queda' : 'quedan'} ${u.left} de ${u.limit} acciones de Claude y ChatGPT ${week ? 'esta semana (se renueva el lunes)' : 'este mes (se renueva el día 1)'}.`;
  }
  if (l === 'pt') {
    return `Kaption: ${u.left === 1 ? 'resta' : 'restam'} ${u.left} de ${u.limit} ações do Claude e ChatGPT ${week ? 'nesta semana (renova na segunda-feira)' : 'neste mês (renova no dia 1)'}.`;
  }
  return `Kaption: ${u.left} of ${u.limit} Claude and ChatGPT actions left ${week ? 'this week (resets Monday)' : 'this month (resets on the 1st)'}.`;
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

export type UseAnswer =
  /** Let the call run; `counted` when it took a slot on the weekly ledger (give it back if the call fails). */
  | { state: "run"; counted: boolean; actionId: string; usage: Usage | null; lang: UsageLang }
  /** weekly-plan-limits.SERVER.13 — refused at the weekly limit. */
  | { state: "refused"; message: string; usage: Usage | null; lang: UsageLang };

const REFUSAL_FALLBACK = "This Kaption account has used this week's Claude and ChatGPT actions. Tell the user they come back on Monday, or to choose a plan at https://kaptionai.com/pricing for more.";

async function postLedger(env: UsageEnv, path: string, body: unknown, fetchImpl: typeof fetch): Promise<{ status: number; data: any } | null> {
  if (!env.INTERNAL_API_BASE_URL || !env.INTERNAL_API_KEY) return null;
  try {
    const res = await fetchImpl(`${env.INTERNAL_API_BASE_URL.replace(/\/$/, "")}/__internal/mcp-ledger/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env.INTERNAL_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/**
 * weekly-plan-limits.SERVER.13, COUNT.10; mcp-usage-pricing.USAGE.5 — before one cloud call: count it (listed phones, or
 * opts.weekly: rest-api's /access said the account is counted by the week — lifetime-local.HOLDER.7)
 * and/or fetch what is left (usage phones). Null = nothing to do (both switches off for this phone, an uncounted tool,
 * or rest-api could not answer: the call runs as before).
 */
export async function beginUse(env: UsageEnv, phone: string | null, tool: string, actionId: string, fetchImpl: typeof fetch = fetch,
  opts: { weekly?: boolean } = {}): Promise<UseAnswer | null> {
  if (!phone || UNCOUNTED_TOOLS.has(tool)) return null;
  // lifetime-local.HOLDER.7 — also counted when rest-api's /access said the account is weekly (every Lifetime account,
  // whatever WEEKLY_PLAN_LIMITS_PHONES says here); rest-api still decides at /use.
  const count = weeklyPhone(phone, env) || opts.weekly === true;
  const show = usagePhone(phone, env);
  if (!count && !show) return null;
  // Usage only: /access answers it without counting anything.
  const r = await postLedger(env, count ? "use" : "access", { phone, ...(count ? { change: "reserve", actionId } : {}), ...(show ? { usage: true } : {}) }, fetchImpl);
  if (!r || !r.data) return null;
  const usage = show ? normalizeUsage(r.data.usage) : null;
  const lang = usageLang(r.data.lang);
  if (count && r.status === 402) return { state: "refused", message: typeof r.data.message === "string" && r.data.message ? r.data.message : REFUSAL_FALLBACK, usage, lang };
  if (r.status !== 200) return null;
  return { state: "run", counted: count && r.data.counted === true, actionId, usage, lang };
}

/** weekly-plan-limits.LIMITS.14 — a failed call gives its slot (or its charge) back. Never throws. */
export async function refundUse(env: UsageEnv, phone: string, actionId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await postLedger(env, "use", { phone, change: "refund", actionId }, fetchImpl);
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
