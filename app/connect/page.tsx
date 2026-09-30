"use client";

/**
 * /connect — mcp.CONNECT_CODE.4: where Kaption's "Add to Claude / ChatGPT" lands. The code arrives in the URL
 * fragment (#c=…, never sent to a server by the browser), is remembered on this browser for Kaption's sign-in page,
 * and the page shows the one thing left to do: add the connector in the app. Nothing here signs anyone in.
 */
import { useEffect, useState } from "react";
import { rich, useI18n } from "../LanguageProvider";
import { translateError } from "../i18n";

const APPS = {
  claude: {
    name: "Claude",
    open: "https://claude.ai/settings/connectors",
    steps: ["connect.claude_step1", "connect.claude_step2", "connect.claude_step3"],
  },
  chatgpt: {
    name: "ChatGPT",
    open: "https://chatgpt.com/#settings/Connectors",
    steps: ["connect.chatgpt_step1", "connect.chatgpt_step2", "connect.chatgpt_step3"],
  },
} as const;

type AppId = keyof typeof APPS;

export default function ConnectPage() {
  const { t } = useI18n();
  const [state, setState] = useState<"working" | "ready" | "failed">("working");
  const [masked, setMasked] = useState("");
  // A translation key and its values (or a server's message), so the text follows a language change.
  const [error, setError] = useState<{ key?: string; params?: Record<string, string>; text?: string }>({});
  const [copied, setCopied] = useState(false);
  const [appId, setAppId] = useState<AppId>("claude");
  const [server, setServer] = useState("https://mcp.kaptionai.com/mcp");

  useEffect(() => {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("app");
    if (requested === "chatgpt" || requested === "claude") setAppId(requested);
    setServer(`${url.origin}/mcp`);
    const code = new URLSearchParams(url.hash.replace(/^#/, "")).get("c") ?? "";
    // The code leaves the address bar right away (history, screenshots, sharing the link).
    window.history.replaceState(null, "", url.pathname + url.search);
    if (!code) {
      setState("failed");
      setError({ key: "connect.no_code", params: { app: APPS[requested === "chatgpt" ? "chatgpt" : "claude"].name } });
      return;
    }
    void fetch("/connect/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then(async (res) => {
        const data = (await res.json()) as { masked?: string; error?: string; errorKey?: string; errorParams?: Record<string, string> };
        if (res.ok && data.masked) {
          setMasked(data.masked);
          setState("ready");
        } else {
          setError(data.errorKey ? { key: data.errorKey, params: data.errorParams } : data.error ? { text: data.error } : { key: "connect.expired" });
          setState("failed");
        }
      })
      .catch(() => {
        setError({ key: "connect.network_error" });
        setState("failed");
      });
  }, []);

  const app = APPS[appId];
  const errorText = translateError(t, { errorKey: error.key, errorParams: error.params, error: error.text }, "connect.expired");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(server);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-5">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[440px] w-full" data-testid="connect-page">
        <h1 className="text-xl mb-2 text-neutral-50">{t("connect.title", { app: app.name })}</h1>
        {state === "working" && <p className="text-sm text-neutral-400">{t("connect.working")}</p>}
        {state === "failed" && <p className="text-sm text-red-400" role="alert">{errorText}</p>}
        {state === "ready" && (
          <>
            <p className="text-sm text-neutral-400 mb-5 leading-relaxed">
              {rich(t("connect.ready"), { masked: <span className="text-neutral-50 font-medium">{masked}</span> })}
            </p>
            <label htmlFor="serverUrl" className="block text-[13px] text-neutral-400 mb-1.5">{t("connect.address_label")}</label>
            <div className="flex gap-2">
              <input
                id="serverUrl"
                readOnly
                value={server}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-sm font-mono outline-none"
              />
              <button
                type="button"
                onClick={() => { void copy(); }}
                className="px-4 rounded-lg bg-neutral-800 text-neutral-50 text-sm font-semibold hover:bg-neutral-700"
              >
                {copied ? t("connect.copied") : t("connect.copy")}
              </button>
            </div>
            <ol className="mt-5 flex flex-col gap-2 text-sm text-neutral-300 list-decimal pl-5">
              {app.steps.map((step) => <li key={step}>{t(step)}</li>)}
            </ol>
            <a
              href={app.open}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => { void copy(); }}
              className="block text-center w-full py-3 rounded-lg bg-green-500 text-neutral-950 font-semibold text-sm mt-6 hover:bg-green-600"
            >
              {t("connect.open", { app: app.name })}
            </a>
            <p className="text-xs text-neutral-500 mt-3">
              {t("connect.footnote", { app: app.name })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
