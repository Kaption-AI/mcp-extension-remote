"use client";

/**
 * mcp.CONNECT_CODE.4-5 — the sign-in page Claude or ChatGPT opens. First, the Kaption code: already there when this
 * browser came from Kaption's Add to Claude (the /connect page remembered it; only the masked phone shows), otherwise
 * pasted from Kaption. "Use my phone number instead" is today's phone + WhatsApp code form, unchanged.
 */
import { useState } from "react";
import Destination from "./Destination";
import PhoneForm from "./PhoneForm";
import {
  DEFAULT_CONNECTION_LIFETIME,
  LIFETIME_CHOICES,
  parseConnectionLifetime,
  type ConnectionLifetime,
} from "@/src/connection-lifetime-options";
import { rich, useI18n } from "../LanguageProvider";
import { translateError } from "../i18n";

export default function SignIn({
  oauthReqInfo,
  loginHint = "",
  rememberedFor,
  appName,
  destination,
}: {
  oauthReqInfo: string;
  loginHint?: string;
  rememberedFor: string | null;
  appName: string | null;
  destination: string | null;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"code" | "phone">(loginHint ? "phone" : "code");
  const [useRemembered, setUseRemembered] = useState(!!rememberedFor);
  const [code, setCode] = useState("");
  const [lifetime, setLifetime] = useState<ConnectionLifetime>(DEFAULT_CONNECTION_LIFETIME);
  const [error, setError] = useState<{ error?: string; errorKey?: string; errorParams?: Record<string, string> } | null>(null);
  const [loading, setLoading] = useState(false);
  const app = appName || t("signin.this_app");

  if (mode === "phone" || !oauthReqInfo) {
    return (
      <div className="flex flex-col items-center gap-3 w-full max-w-[400px]">
        <PhoneForm oauthReqInfo={oauthReqInfo} loginHint={loginHint} appName={appName} destination={destination} />
        {oauthReqInfo && (
          <button type="button" onClick={() => setMode("code")} className="text-sm text-green-400 hover:underline">
            {t("signin.use_code")}
          </button>
        )}
      </div>
    );
  }

  const selectedChoice = LIFETIME_CHOICES.find((choice) => choice.id === lifetime) ?? LIFETIME_CHOICES[0];

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/authorize/connect-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oauthReqInfo,
          connectionLifetime: lifetime,
          ...(useRemembered ? { remembered: true } : { code }),
        }),
      });
      const data = (await res.json()) as {
        redirectTo?: string;
        error?: string;
        errorKey?: string;
        errorParams?: Record<string, string>;
        forget?: boolean;
      };
      if (res.ok && data.redirectTo) {
        window.location.assign(data.redirectTo);
        return;
      }
      if (data.forget) setUseRemembered(false);
      setError((data.error || data.errorKey) ? data : { errorKey: "signin.connect_failed" });
    } catch {
      setError({ errorKey: "common.network_error" });
    }
    setLoading(false);
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
      <h1 className="text-xl mb-2 text-neutral-50">{t("signin.title", { app })}</h1>
      <Destination destination={destination} />
      {useRemembered && rememberedFor ? (
        <p className="text-sm text-neutral-400 mb-6 leading-relaxed" data-testid="connect-remembered">
          {rich(t("signin.remembered", { app }), {
            masked: <span className="text-neutral-50 font-medium">{rememberedFor}</span>,
          })}{" "}
          <button type="button" className="text-green-400 hover:underline" onClick={() => setUseRemembered(false)}>
            {t("signin.not_you")}
          </button>
        </p>
      ) : (
        <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
          {t("signin.paste_hint")}
        </p>
      )}

      <form onSubmit={connect}>
        {!(useRemembered && rememberedFor) && (
          <>
            <label htmlFor="connectCode" className="block text-[13px] text-neutral-400 mb-1.5">
              {t("signin.code_label")}
            </label>
            <input
              id="connectCode"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD-2345"
              required
              autoFocus
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-base tracking-[0.12em] font-mono outline-none focus:border-green-500"
            />
          </>
        )}

        <label htmlFor="connectionLifetime" className="block text-[13px] text-neutral-400 mt-5 mb-1.5">
          {t("lifetime.label")}
        </label>
        <select
          id="connectionLifetime"
          value={lifetime}
          onChange={(e) => setLifetime(parseConnectionLifetime(e.target.value))}
          aria-describedby="connectionLifetimeDetail"
          style={{ colorScheme: "dark" }}
          className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-sm outline-none cursor-pointer focus:border-green-500"
        >
          {LIFETIME_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.id === DEFAULT_CONNECTION_LIFETIME
                ? t("lifetime.recommended", { title: t(`lifetime.${choice.id}.title`) })
                : t(`lifetime.${choice.id}.title`)}
            </option>
          ))}
        </select>
        <p id="connectionLifetimeDetail" className="text-xs text-neutral-400 mt-2">{t(`lifetime.${selectedChoice.id}.detail`)}</p>

        {error && (
          <p className="text-red-500 text-[13px] mt-3" role="alert">
            {translateError(t, error, "signin.connect_failed")}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-lg border-none bg-green-500 text-neutral-950 font-semibold text-sm cursor-pointer mt-5 hover:bg-green-600 disabled:opacity-50 disabled:cursor-wait"
        >
          {loading ? t("signin.connecting") : t("signin.connect")}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setMode("phone")}
        className="block mx-auto mt-4 text-sm text-neutral-400 hover:text-neutral-200 hover:underline"
      >
        {t("signin.use_phone")}
      </button>
    </div>
  );
}
