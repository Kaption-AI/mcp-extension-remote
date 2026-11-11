"use client";

/**
 * mcp.ANY_CLIENT.4-12 — "Sign in with Kaption on this computer": no phone number, no WhatsApp code. The page makes an
 * approval request for this sign-in (bound to this browser), hands its id to the Kaption extension in this browser,
 * waits while Kaption asks in WhatsApp, then completes the sign-in once it was approved.
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../LanguageProvider";
import { translateError } from "../i18n";
import { handOffToExtension } from "./extension-bridge";
import type { ConnectionLifetime } from "@/src/connection-lifetime-options";

type ErrorState = { error?: string; errorKey?: string; errorParams?: Record<string, string> } | null;
type Phase = "idle" | "starting" | "waiting" | "completing" | "denied" | "expired" | "failed";

const POLL_MS = 1500;

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, data };
}

export default function ApproveOnComputer({
  oauthReqInfo,
  extensionId,
  lifetime,
  primary = true,
}: {
  oauthReqInfo: string;
  extensionId: string;
  lifetime: ConnectionLifetime;
  primary?: boolean;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<ErrorState>(null);
  const run = useRef(0);
  useEffect(() => () => { run.current += 1; }, []);

  async function start() {
    const id = run.current + 1;
    run.current = id;
    setError(null);
    setPhase("starting");
    try {
      const started = await postJson("/authorize/approval/start", { oauthReqInfo });
      if (run.current !== id) return;
      if (!started.ok || typeof started.data?.requestId !== "string") {
        setError(started.data ?? { errorKey: "signin.connect_failed" });
        setPhase("failed");
        return;
      }
      const requestId: string = started.data.requestId;
      // mcp.ANY_CLIENT.6 — only the id this page just created goes to the extension.
      const handed = await handOffToExtension(extensionId, requestId);
      if (run.current !== id) return;
      if (!handed.ok) {
        setError({ errorKey: handed.reason === "no_whatsapp" ? "approve.no_whatsapp" : handed.reason === "signed_out" ? "approve.signed_out" : "approve.no_answer" });
        setPhase("failed");
        return;
      }
      setPhase("waiting");
      // mcp.ANY_CLIENT.12 — wait for Allow or Deny in WhatsApp.
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (run.current !== id) return;
        const polled = await postJson("/authorize/approval/status", { requestId }).catch(() => ({ ok: false, data: null }));
        if (run.current !== id) return;
        const status = polled.data?.status;
        if (status === "pending" || !polled.ok) continue;
        if (status === "denied") { setPhase("denied"); return; }
        if (status !== "approved") { setPhase("expired"); return; }
        break;
      }
      setPhase("completing");
      const done = await postJson("/authorize/approval/complete", { requestId, oauthReqInfo, connectionLifetime: lifetime });
      if (run.current !== id) return;
      if (done.ok && typeof done.data?.redirectTo === "string") {
        window.location.assign(done.data.redirectTo);
        return;
      }
      setError(done.data ?? { errorKey: "signin.connect_failed" });
      setPhase("failed");
    } catch {
      if (run.current !== id) return;
      setError({ errorKey: "common.network_error" });
      setPhase("failed");
    }
  }

  const busy = phase === "starting" || phase === "waiting" || phase === "completing";
  return (
    <div data-testid="approve-on-computer" data-phase={phase}>
      {!busy && (
        <button
          type="button"
          onClick={() => { void start(); }}
          data-testid="approve-start"
          className={primary
            ? "w-full py-3 rounded-lg border-none bg-green-500 text-neutral-950 font-semibold text-sm cursor-pointer hover:bg-green-600"
            : "w-full py-3 rounded-lg border border-neutral-700 bg-transparent text-neutral-100 font-semibold text-sm cursor-pointer hover:border-green-500"}
        >
          {phase === "idle" ? t("approve.button") : t("approve.try_again")}
        </button>
      )}
      {phase === "idle" && <p className="text-xs text-neutral-500 mt-2">{t("approve.hint")}</p>}
      {busy && (
        <p className="text-sm text-neutral-300 py-3" role="status" data-testid="approve-waiting">
          {phase === "waiting" ? t("approve.waiting") : t("signin.connecting")}
        </p>
      )}
      {phase === "denied" && <p className="text-red-500 text-[13px] mt-3" role="alert">{t("approve.denied")}</p>}
      {phase === "expired" && <p className="text-red-500 text-[13px] mt-3" role="alert">{t("approve.expired")}</p>}
      {phase === "failed" && error && (
        <p className="text-red-500 text-[13px] mt-3" role="alert">{translateError(t, error, "signin.connect_failed")}</p>
      )}
    </div>
  );
}
