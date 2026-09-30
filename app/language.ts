/**
 * mcp.CONNECT_CODE.8 — which language a page speaks: the supported languages and the choice between the `lang` param,
 * the kaption_lang cookie, the stored language and the browser's. No translations here, so middleware stays small.
 */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "tr", label: "Türkçe" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ja", label: "日本語" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE: LanguageCode = "en";

/** The cookie /connect sets from `?lang=`: path /, SameSite=Lax, a year. Not HttpOnly — it's only a preference. */
export const LANG_COOKIE = "kaption_lang";
export const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
/** The Worker (withPageLanguage) hands this render the `lang` param in this request header (the root layout can't see the query). */
export const LANG_HEADER = "x-kaption-lang";
/** The key the landing page's language picker has always used. */
export const LANG_STORAGE_KEY = "language";

const SUPPORTED = new Set<string>(LANGUAGES.map((l) => l.code));

/**
 * Any spelling of a supported language → its code, else null. Accepts "es", "es-AR", "pt_BR", "zh_TW", "zh-Hant-HK",
 * and the old "zh" (stored by earlier versions of the landing page), which means Simplified Chinese.
 */
export function normalizeLanguage(input: unknown): LanguageCode | null {
  if (typeof input !== "string") return null;
  const tag = input.trim().replace(/_/g, "-").toLowerCase();
  if (!tag || tag.length > 35 || !/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(tag)) return null;
  const [base, ...rest] = tag.split("-");
  if (base === "zh") {
    if (rest.includes("hant") || rest.some((p) => p === "tw" || p === "hk" || p === "mo")) return "zh-TW";
    return "zh-CN";
  }
  return SUPPORTED.has(base) ? (base as LanguageCode) : null;
}

/** The best supported language in an Accept-Language header (by q, then order), or null. */
export function languageFromAcceptLanguage(header: string | null | undefined): LanguageCode | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of ranked) {
    const lang = normalizeLanguage(entry.tag);
    if (lang) return lang;
  }
  return null;
}

/** First language in a navigator.languages-style list we support, or null. */
export function languageFromList(list: readonly string[] | null | undefined): LanguageCode | null {
  for (const tag of list ?? []) {
    const lang = normalizeLanguage(tag);
    if (lang) return lang;
  }
  return null;
}

export type LanguageSource = "query" | "cookie" | "stored" | "browser" | "default";

export interface LanguageInputs {
  /** `lang` query param. */
  query?: string | null;
  /** kaption_lang cookie. */
  cookie?: string | null;
  /** localStorage "language" (client only). */
  stored?: string | null;
  /** Accept-Language header (server). */
  acceptLanguage?: string | null;
  /** navigator.languages (client). */
  browserLanguages?: readonly string[] | null;
}

/** mcp.CONNECT_CODE.8 — query, cookie, stored, browser, English: the first one that names a supported language. */
export function resolveLanguage(inputs: LanguageInputs): { lang: LanguageCode; source: LanguageSource } {
  const query = normalizeLanguage(inputs.query);
  if (query) return { lang: query, source: "query" };
  const cookie = normalizeLanguage(inputs.cookie);
  if (cookie) return { lang: cookie, source: "cookie" };
  const stored = normalizeLanguage(inputs.stored);
  if (stored) return { lang: stored, source: "stored" };
  const browser = languageFromAcceptLanguage(inputs.acceptLanguage) ?? languageFromList(inputs.browserLanguages);
  if (browser) return { lang: browser, source: "browser" };
  return { lang: DEFAULT_LANGUAGE, source: "default" };
}

/** Read one cookie out of a Cookie header / document.cookie. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The Set-Cookie value that remembers a language on this site. */
export function languageCookie(lang: LanguageCode, secure = true): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

