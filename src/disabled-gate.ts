/**
 * disabled-gating.MCP.1-5, SWITCH.4 (Kaption-AI monorepo: features/rest-api/disabled-gating.feature.yaml) — a blocked
 * (DISABLED) Kaption account gets no Claude or ChatGPT actions through the cloud relay.
 *
 * Only accounts whose phone is in DISABLED_FULL_GATING_PHONES ("*" = everyone; unset or empty = nobody) are asked
 * about; for every other account nothing is asked and every call runs exactly as before. A listed account is asked
 * once per ttl_seconds at rest-api's POST /__internal/mcp-ledger/access {phone} (the key the relay already holds),
 * which decides from the DB row and the effective plan (grants, packs and Lifetime count) and applies rest-api's own
 * switch. When rest-api cannot answer the call runs (MCP.5) and the next call asks again.
 *
 * The plans, checkout and help tools keep answering (MCP.2) so the assistant can tell the user how to come back.
 */
import type { Env } from "./types";

/** disabled-gating.MCP.2 */
export const DISABLED_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "kaption_plans",
  "create_kaption_checkout_link",
  "kaption_help",
  "report_bug",
  "get_api_info",
]);
export const DISABLED_PLANS_URL = "https://kaptionai.com/pricing";
/** disabled-gating.MCP.1 — used when rest-api's answer carries no message of its own. */
export const DISABLED_FALLBACK_TEXT = `This Kaption account is disabled, so Claude and ChatGPT actions are not available. Tell the user to choose a plan at ${DISABLED_PLANS_URL} (or in Kaption on WhatsApp Web, Your Plan) to use them again.`;
/** Recorded in the usage ledger as a refused call (usage.ts outcomeOf). */
export const DISABLED_CODE = "refused";
const DEFAULT_TTL_S = 600;

type GateEnv = Pick<Env, "INTERNAL_API_BASE_URL" | "INTERNAL_API_KEY" | "DISABLED_FULL_GATING_PHONES">;

const digitsOf = (value: unknown) => String(value ?? "").replace(/\D/g, "");

/** disabled-gating.SWITCH.4 — is this phone in the relay's rollout list. */
export function gatedPhone(phone: unknown, env: Pick<Env, "DISABLED_FULL_GATING_PHONES">): boolean {
  const digits = digitsOf(phone);
  if (!digits) return false;
  const list = String(env.DISABLED_FULL_GATING_PHONES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.some((entry) => digitsOf(entry) === digits);
}

/** Any phone listed at all (so a session with the list unset never even looks its phone up). */
export function gatingConfigured(env: Pick<Env, "DISABLED_FULL_GATING_PHONES">): boolean {
  return String(env.DISABLED_FULL_GATING_PHONES ?? "").split(",").some((s) => s.trim());
}

export interface AccessAnswer {
  blocked: boolean;
  message: string | null;
  ttlSeconds: number;
  /**
   * lifetime-local.HOLDER.7 (Kaption-AI monorepo) — rest-api counts this account's Claude/ChatGPT calls by the week
   * (`weekly: true`, or a weekly-limit-reached refusal): every Lifetime account, and free/lifetime inside
   * WEEKLY_PLAN_LIMITS. The relay then counts each cloud call on the weekly ledger (weekly-usage.ts beginUse).
   */
  weekly: boolean;
}

/** disabled-gating.MCP.3 — rest-api's answer, or null when it cannot answer (MCP.5). */
export async function fetchAccess(env: GateEnv, phone: string, fetchImpl: typeof fetch = fetch): Promise<AccessAnswer | null> {
  if (!env.INTERNAL_API_BASE_URL || !env.INTERNAL_API_KEY) return null;
  try {
    const res = await fetchImpl(`${env.INTERNAL_API_BASE_URL.replace(/\/$/, "")}/__internal/mcp-ledger/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env.INTERNAL_API_KEY },
      body: JSON.stringify({ phone }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 200) return null;
    const d = (await res.json().catch(() => null)) as { blocked?: unknown; message?: unknown; ttl_seconds?: unknown; weekly?: unknown; code?: unknown } | null;
    if (!d || typeof d.blocked !== "boolean") return null;
    const ttl = typeof d.ttl_seconds === "number" && Number.isInteger(d.ttl_seconds) && d.ttl_seconds >= 30 && d.ttl_seconds <= 86_400 ? d.ttl_seconds : DEFAULT_TTL_S;
    const weekly = d.weekly === true || d.code === "weekly-limit-reached";
    return { blocked: d.blocked, message: typeof d.message === "string" && d.message ? d.message : null, ttlSeconds: ttl, weekly };
  } catch {
    return null;
  }
}

/** One session's view of whether its account is blocked (kept for the answer's ttl). */
export class DisabledGate {
  private view: { answer: AccessAnswer; until: number } | null = null;

  constructor(
    private readonly deps: {
      env: GateEnv;
      /** The account's phone (the relay room's metering phone), or null when unknown. */
      phone: () => Promise<string | null>;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  /** disabled-gating.MCP.1-2, MCP.5 — the refusal text for this tool call, or null to let it run. */
  async refusal(tool: string): Promise<string | null> {
    if (DISABLED_ALLOWED_TOOLS.has(tool)) return null;
    if (!gatingConfigured(this.deps.env)) return null;
    const now = (this.deps.now ?? Date.now)();
    if (this.view && this.view.until > now) return this.text(this.view.answer);
    let phone: string | null = null;
    try {
      phone = await this.deps.phone();
    } catch {
      phone = null;
    }
    if (!phone) return null;
    if (!gatedPhone(phone, this.deps.env)) {
      // Outside the rollout: nothing is asked; the room is not looked up again for a while.
      this.view = { answer: { blocked: false, message: null, ttlSeconds: DEFAULT_TTL_S, weekly: false }, until: now + DEFAULT_TTL_S * 1000 };
      return null;
    }
    const answer = await fetchAccess(this.deps.env, phone, this.deps.fetch ?? fetch);
    if (!answer) return null;
    this.view = { answer, until: now + answer.ttlSeconds * 1000 };
    return this.text(answer);
  }

  /**
   * lifetime-local.HOLDER.7 — whether rest-api's last answer (still within its ttl) said this account is counted by the
   * week. False before any answer, after the ttl, or outside the rollout.
   */
  weekly(): boolean {
    const now = (this.deps.now ?? Date.now)();
    return !!this.view && this.view.until > now && this.view.answer.weekly;
  }

  private text(answer: AccessAnswer): string | null {
    return answer.blocked ? answer.message ?? DISABLED_FALLBACK_TEXT : null;
  }
}
