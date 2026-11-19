/**
 * mcp-credits-simple.ASK.3, ASK.7-9, FLAG.2 (kaptionai features/mcp/mcp-credits-simple.feature.yaml) — the
 * allow_extra_actions tool: the person said yes once to extra Claude and ChatGPT actions. rest-api decides and stores
 * it (/__internal/mcp-ledger/allow-extra); this relay only forwards and passes the words back. Listed only for an
 * account whose plan answer carries the credits block (MCP_CREDITS_SIMPLE on), never counted.
 */
import { z } from "zod";
import type { Env } from "./types";

export const ALLOW_EXTRA_TOOL = "allow_extra_actions";

export const ALLOW_EXTRA_DEFINITION = {
  title: "Allow extra actions",
  description:
    "Call this only after the user agreed, in this conversation, to keep using Kaption past their plan's included Claude and ChatGPT actions. " +
    "It turns extra actions on, up to the user's monthly limit, and Kaption will not ask again. Never call it without the user's yes.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export interface AllowExtraAnswer {
  ok: boolean;
  message: string;
}

/** ASK.3 — rest-api's answer; a failure says so (and changes nothing). */
export async function allowExtra(
  env: Pick<Env, "INTERNAL_API_BASE_URL" | "INTERNAL_API_KEY">,
  phone: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AllowExtraAnswer> {
  const failed = { ok: false, message: "Kaption could not turn extra actions on right now. Ask the user to try again in a moment, or set a monthly limit in Kaption (AI assistants → Usage)." };
  if (!env.INTERNAL_API_BASE_URL || !env.INTERNAL_API_KEY) return failed;
  try {
    const res = await fetchImpl(`${env.INTERNAL_API_BASE_URL.replace(/\/$/, "")}/__internal/mcp-ledger/allow-extra`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env.INTERNAL_API_KEY },
      body: JSON.stringify({ phone }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 200) return failed;
    const body = (await res.json().catch(() => null)) as { ok?: unknown; message?: unknown } | null;
    if (!body || typeof body.message !== "string") return failed;
    return { ok: body.ok === true, message: body.message.slice(0, 2000) };
  } catch {
    return failed;
  }
}
