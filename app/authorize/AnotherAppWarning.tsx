"use client";

/**
 * mcp.ANOTHER_APP.5 — the sign-in page for an app Kaption doesn't know: a warning that names the redirect's real host
 * (not the name the app registered with, which anyone can choose) and the "I know and trust this site" tick. The
 * page keeps Connect / Send verification code disabled until it is ticked; the server checks the tick too (.6).
 */
import { rich, useI18n } from "../LanguageProvider";

export default function AnotherAppWarning({
  host,
  trusted,
  onTrustedChange,
}: {
  host: string;
  trusted: boolean;
  onTrustedChange: (trusted: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3.5 mb-5" data-testid="another-app-warning" role="alert">
      <p className="text-sm text-amber-100 leading-relaxed">
        <span aria-hidden="true">⚠ </span>
        {rich(t("another.warning"), { host: <strong className="text-amber-50 font-semibold break-all" data-testid="another-app-host">{host}</strong> })}
      </p>
      <p className="text-xs text-amber-200/80 mt-1.5 leading-relaxed">{t("another.warning_detail")}</p>
      <label className="flex items-center gap-2.5 mt-3 text-sm text-neutral-50 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={trusted}
          onChange={(e) => onTrustedChange(e.target.checked)}
          data-testid="another-app-trust"
          className="h-4 w-4 accent-green-500 cursor-pointer"
        />
        {t("another.trust")}
      </label>
    </div>
  );
}
