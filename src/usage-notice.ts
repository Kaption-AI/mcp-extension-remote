/**
 * mcp-usage-pricing.WARN.1, RELAY.1 — the extension marks a tool result with `_kaption_notice` when a Claude and
 * ChatGPT usage warning is due (80% of the allowance, extras started, pace, limit, ceiling, Free 80/100). The relay
 * moves it out of the JSON into its own text line after the result, so the assistant reads it as a note for the
 * person. Without the field the result is returned unchanged (inert for every account the extension does not mark).
 */
export const USAGE_NOTICE_FIELD = "_kaption_notice";
const MAX_NOTICE = 1000;

export function takeUsageNotice<T>(result: T): { result: T; notice: string | null } {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { result, notice: null };
  const record = result as Record<string, unknown>;
  if (!(USAGE_NOTICE_FIELD in record)) return { result, notice: null };
  const { [USAGE_NOTICE_FIELD]: raw, ...rest } = record;
  const notice = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, MAX_NOTICE) : null;
  return { result: rest as T, notice };
}
