"use client";

/**
 * mcp.CONNECT_CODE.8 — the page language on the client. The root layout renders it with the server's choice (`lang`
 * param, kaption_lang cookie, Accept-Language); here, when that choice was only the browser's language, the language
 * stored on this browser ("language", the landing page's picker) wins, as it can't be read on the server.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_LANGUAGE,
  LANG_COOKIE,
  LANG_STORAGE_KEY,
  getT,
  languageCookie,
  normalizeLanguage,
  readCookie,
  resolveLanguage,
  type LanguageCode,
  type LanguageSource,
  type TFunc,
} from "./i18n";

interface LanguageContextValue {
  lang: LanguageCode;
  t: TFunc;
  setLang: (code: string) => void;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: DEFAULT_LANGUAGE,
  t: getT(DEFAULT_LANGUAGE),
  setLang: () => {},
});

export function LanguageProvider({
  initial,
  source,
  children,
}: {
  initial: LanguageCode;
  source: LanguageSource;
  children: ReactNode;
}) {
  const [lang, setLangState] = useState<LanguageCode>(initial);

  useEffect(() => {
    const query = normalizeLanguage(new URLSearchParams(window.location.search).get("lang"));
    // The Worker already set the cookie for ?lang=; this covers `next dev` and anything that skipped it.
    if (query && readCookie(document.cookie, LANG_COOKIE) !== query) {
      try {
        document.cookie = languageCookie(query, window.location.protocol === "https:");
      } catch {}
    }
    if (source === "query" || source === "cookie") return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LANG_STORAGE_KEY);
    } catch {}
    const { lang: resolved } = resolveLanguage({
      query,
      cookie: readCookie(document.cookie, LANG_COOKIE),
      stored,
      browserLanguages: source === "default" ? navigator.languages : [initial],
    });
    if (resolved !== initial) setLangState(resolved);
  }, [initial, source]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((code: string) => {
    const next = normalizeLanguage(code);
    if (!next) return;
    setLangState(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {}
    try {
      document.cookie = languageCookie(next, window.location.protocol === "https:");
    } catch {}
  }, []);

  const value = useMemo(() => ({ lang, t: getT(lang), setLang }), [lang, setLang]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n(): LanguageContextValue {
  return useContext(LanguageContext);
}

/** A translation whose {{placeholders}} are elements (e.g. the masked phone in bold). */
export function rich(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\{\w+\}\})/).map((piece, index) => {
    const m = /^\{\{(\w+)\}\}$/.exec(piece);
    const node = m && Object.prototype.hasOwnProperty.call(nodes, m[1]) ? nodes[m[1]] : piece;
    return <Fragment key={index}>{node}</Fragment>;
  });
}
