"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useI18n } from "../LanguageProvider";
import { translateError } from "../i18n";

type ErrorState = { error?: string; errorKey?: string; errorParams?: Record<string, string> } | null;

export default function PhoneForm({ oauthReqInfo, loginHint = "" }: { oauthReqInfo: string; loginHint?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [phone, setPhone] = useState(loginHint);
  const [error, setError] = useState<ErrorState>(null);
  const [loading, setLoading] = useState(false);
  const [reviewPassword, setReviewPassword] = useState("");
  const [reviewMode, setReviewMode] = useState(false);

  if (!oauthReqInfo) {
    return (
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
        <h1 className="text-xl mb-2 text-neutral-50">{t("common.invalid_request")}</h1>
        <p className="text-sm text-neutral-400">
          {t("phone.missing_state")}
        </p>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const normalized = phone.replace(/[\s\-\+\(\)]/g, "");

    try {
      const res = await fetch(
        reviewMode ? "/authorize/reviewer-login" : "/authorize/send-otp",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: normalized,
          oauthReqInfo,
          ...(reviewMode ? { password: reviewPassword } : {}),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        verifyTicket?: string;
        reviewPasswordRequired?: boolean;
        redirectTo?: string;
        error?: string;
        errorKey?: string;
        errorParams?: Record<string, string>;
      };

      if (res.ok && data.redirectTo) {
        window.location.assign(data.redirectTo);
      } else if (data.ok && data.reviewPasswordRequired) {
        setReviewMode(true);
        setLoading(false);
      } else if (data.ok && data.verifyTicket) {
        router.push(
          `/authorize/verify?ticket=${encodeURIComponent(data.verifyTicket)}`,
        );
      } else {
        setError((data.error || data.errorKey) ? data : { errorKey: "common.send_failed" });
        setLoading(false);
      }
    } catch {
      setError({ errorKey: "common.network_error" });
      setLoading(false);
    }
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
      <h1 className="text-xl mb-2 text-neutral-50">Kaption MCP</h1>
      <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
        {t("phone.intro")}
      </p>

      <form onSubmit={handleSubmit}>
        <label
          htmlFor="phone"
          className="block text-[13px] text-neutral-400 mb-1.5"
        >
          {t("common.phone_label")}
        </label>
        <input
          type="tel"
          id="phone"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setReviewMode(false);
            setReviewPassword("");
          }}
          placeholder="1234567890"
          required
          autoComplete="tel"
          className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-base outline-none focus:border-green-500"
        />
        <p className="text-xs text-neutral-500 mt-1.5">
          {t("common.phone_hint")}
        </p>

        {reviewMode && (
          <>
            <label htmlFor="review-password" className="block text-[13px] text-neutral-400 mb-1.5 mt-4">
              {t("phone.review_password")}
            </label>
            <input
              id="review-password"
              type="password"
              value={reviewPassword}
              onChange={(e) => setReviewPassword(e.target.value)}
              required
              autoFocus
              autoComplete="current-password"
              className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-base outline-none focus:border-green-500"
            />
          </>
        )}

        {error && <p className="text-red-500 text-[13px] mt-2">{translateError(t, error, "common.send_failed")}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-lg border-none bg-green-500 text-neutral-950 font-semibold text-sm cursor-pointer mt-4 hover:bg-green-600 disabled:opacity-50 disabled:cursor-wait"
        >
          {loading
            ? (reviewMode ? t("phone.signing_in") : t("common.sending"))
            : (reviewMode ? t("phone.sign_in") : t("phone.send_code"))}
        </button>
      </form>
    </div>
  );
}
