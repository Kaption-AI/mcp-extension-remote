/**
 * i18n for the connector's pages (landing, /connect, /authorize, /ext-auth, /support) — plain functions, no React, so
 * server components, client components, route handlers and the Worker all share them.
 *
 * mcp.CONNECT_CODE.8 — the language, in order: 1) a `lang` query param, or the kaption_lang cookie (set by /connect
 * from that param, so the later sign-in page Claude or ChatGPT opens speaks it too); 2) the "language" stored on this
 * browser (client only); 3) Accept-Language (server) / navigator.languages (client); 4) English.
 */
import en from "./locales/en.json";
import es from "./locales/es.json";
import pt from "./locales/pt.json";
import it from "./locales/it.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import tr from "./locales/tr.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import ja from "./locales/ja.json";

import { DEFAULT_LANGUAGE, normalizeLanguage, type LanguageCode } from "./language";

export * from "./language";

export const resources: Record<LanguageCode, Record<string, string>> = {
  en,
  es,
  pt,
  fr,
  de,
  it,
  tr,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
};

export type TParams = Record<string, string | number>;
export type TFunc = (key: string, params?: TParams) => string;

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Get a translation function for a given language; missing keys fall back to English, then to the key. */
export function getT(lang: string): TFunc {
  const dict = resources[normalizeLanguage(lang) ?? DEFAULT_LANGUAGE];
  const fallback = resources.en;
  return (key, params) => interpolate(dict[key] ?? fallback[key] ?? key, params);
}

export function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(resources.en, key);
}

// ─── Server error messages ────────────────────────────────────────────
// Routes keep answering `error` in English (logs, API clients, tests) and add `errorKey` (+ `errorParams`) so the
// page shows it in the reader's language. The key is found from the English text in en.json ("err.*").

const ERROR_PATTERNS: { key: string; names: string[]; pattern: RegExp }[] = Object.entries(resources.en)
  .filter(([key]) => key.startsWith("err."))
  .map(([key, template]) => {
    const names: string[] = [];
    const source = template
      .split(/(\{\{\w+\}\})/)
      .map((piece) => {
        const m = /^\{\{(\w+)\}\}$/.exec(piece);
        if (m) {
          names.push(m[1]);
          return "(.+?)";
        }
        return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return { key, names, pattern: new RegExp(`^${source}$`) };
  });

/** The en.json key (and its values) for an English server message, or null. */
export function errorKeyFor(message: string): { key: string; params?: TParams } | null {
  for (const { key, names, pattern } of ERROR_PATTERNS) {
    const m = pattern.exec(message);
    if (!m) continue;
    if (!names.length) return { key };
    const params: TParams = {};
    names.forEach((name, i) => {
      params[name] = m[i + 1];
    });
    return { key, params };
  }
  return null;
}

/** `{ error, errorKey?, errorParams? }` for an English server message. */
export function errorBody(text: string | undefined): { error: string; errorKey?: string; errorParams?: TParams } {
  const message = text || resources.en["err.invalid_input"];
  const found = errorKeyFor(message);
  if (!found) return { error: message };
  return found.params ? { error: message, errorKey: found.key, errorParams: found.params } : { error: message, errorKey: found.key };
}

/** A JSON error response whose message the page can translate. */
export function jsonError(message: string | undefined, init?: ResponseInit & { extra?: Record<string, unknown> }): Response {
  const { extra, ...rest } = init ?? {};
  return Response.json({ ...errorBody(message), ...(extra ?? {}) }, rest);
}

/** What a page shows for a server error: the translated message when the server named one, else its text, else the fallback. */
export function translateError(
  t: TFunc,
  data: { error?: string; errorKey?: string; errorParams?: TParams } | null | undefined,
  fallbackKey: string,
): string {
  if (data?.errorKey && hasKey(data.errorKey)) return t(data.errorKey, data.errorParams);
  if (data?.error) {
    const found = errorKeyFor(data.error);
    return found ? t(found.key, found.params) : data.error;
  }
  return t(fallbackKey);
}
