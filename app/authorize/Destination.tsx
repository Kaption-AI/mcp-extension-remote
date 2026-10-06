"use client";

import { rich, useI18n } from "../LanguageProvider";

/** mcp.CONNECT_CODE.5 — where signing in sends the person back, so an app registered as "Claude" can't pass for Claude. */
export default function Destination({ destination }: { destination: string | null }) {
  const { t } = useI18n();
  if (!destination) return null;
  return (
    <p className="text-xs text-neutral-500 -mt-1 mb-4" data-testid="signin-destination">
      {destination === "local"
        ? t("signin.returns_local")
        : rich(t("signin.returns_to"), { host: <span className="text-neutral-200 font-medium">{destination}</span> })}
    </p>
  );
}
