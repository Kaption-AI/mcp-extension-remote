/**
 * mcp.CONNECT_CODE.8 — the connector's pages in the extension's languages: every key in every locale, the language
 * chosen in the right order, and every message a route sends translatable.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import {
  LANGUAGES,
  type LanguageCode,
  LANG_COOKIE,
  errorBody,
  errorKeyFor,
  getT,
  languageCookie,
  languageFromAcceptLanguage,
  normalizeLanguage,
  readCookie,
  resolveLanguage,
  resources,
  translateError,
} from "../app/i18n";
import { CONNECTION_LIFETIMES } from "./connection-lifetime-options";

const APP_DIR = path.resolve(__dirname, "../app");
const en = resources.en;
const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("mcp.CONNECT_CODE.8 locales", () => {
  it("has the extension's 10 languages, each with its own file", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", "es", "pt", "fr", "de", "it", "tr", "zh-CN", "zh-TW", "ja"]);
    const files = readdirSync(path.join(APP_DIR, "locales")).map((f) => f.replace(/\.json$/, "")).sort();
    expect(files).toEqual(LANGUAGES.map((l) => l.code).sort());
  });

  it.each(LANGUAGES.map((l) => l.code))("%s has every key, none empty, none extra, same placeholders", (code: LanguageCode) => {
    const dict = resources[code];
    expect(Object.keys(dict).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in dict))).toEqual([]);
    for (const [key, text] of Object.entries(dict)) {
      expect(typeof text === "string" && text.trim().length > 0, `${code} ${key} is empty`).toBe(true);
      expect(placeholders(String(text)), `${code} ${key} placeholders`).toEqual(placeholders(en[key]));
    }
  });

  it("every literal key the pages use exists", () => {
    const used = new Set<string>();
    for (const file of sourceFiles(APP_DIR)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/\bt\("([\w.-]+)"/g)) used.add(m[1]);
      for (const m of source.matchAll(/(?:errorKey|key): "([\w.-]+)"/g)) used.add(m[1]);
      for (const m of source.matchAll(/"((?:connect|signin|common|verify|phone|ext|support|lifetime)\.[\w.-]+)"/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(50);
    expect([...used].filter((key) => !(key in en))).toEqual([]);
  });

  it("every connection lifetime has a title and a detail", () => {
    for (const id of CONNECTION_LIFETIMES) {
      expect(en[`lifetime.${id}.title`]).toBeTruthy();
      expect(en[`lifetime.${id}.detail`]).toBeTruthy();
    }
  });

  it("interpolates values and falls back to English, then to the key", () => {
    expect(getT("en")("connect.title", { app: "Claude" })).toBe("Connect Claude to your WhatsApp");
    expect(getT("es")("verify.resend_in", { seconds: 42 })).toContain("42");
    expect(getT("xx")("signin.not_you")).toBe("Not you?");
    expect(getT("en")("no.such.key")).toBe("no.such.key");
    // A placeholder with no value is kept, for rich() to fill with an element.
    expect(getT("en")("signin.remembered", { app: "Claude" })).toBe("Claude will use Kaption on WhatsApp {{masked}}.");
  });
});

describe("mcp.CONNECT_CODE.8 language choice", () => {
  it("normalizes any spelling; zh stays an alias of Simplified Chinese", () => {
    expect(normalizeLanguage("es")).toBe("es");
    expect(normalizeLanguage("pt-BR")).toBe("pt");
    expect(normalizeLanguage("pt_BR")).toBe("pt");
    expect(normalizeLanguage("zh")).toBe("zh-CN");
    expect(normalizeLanguage("zh_CN")).toBe("zh-CN");
    expect(normalizeLanguage("zh-Hans")).toBe("zh-CN");
    expect(normalizeLanguage("zh_TW")).toBe("zh-TW");
    expect(normalizeLanguage("zh-tw")).toBe("zh-TW");
    expect(normalizeLanguage("zh-HK")).toBe("zh-TW");
    expect(normalizeLanguage("zh-Hant-HK")).toBe("zh-TW");
    expect(normalizeLanguage("ja-JP")).toBe("ja");
    expect(normalizeLanguage("nl")).toBeNull();
    expect(normalizeLanguage("<script>")).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
  });

  it("reads Accept-Language by weight, skipping what isn't supported", () => {
    expect(languageFromAcceptLanguage("nl-NL,nl;q=0.9,de;q=0.8,en;q=0.7")).toBe("de");
    expect(languageFromAcceptLanguage("en;q=0.5, ja;q=0.9")).toBe("ja");
    expect(languageFromAcceptLanguage("zh-TW,zh;q=0.9")).toBe("zh-TW");
    expect(languageFromAcceptLanguage("fr;q=0, it")).toBe("it");
    expect(languageFromAcceptLanguage("nl")).toBeNull();
    expect(languageFromAcceptLanguage(null)).toBeNull();
  });

  it("order: lang param, then the cookie, then the stored language, then the browser, then English", () => {
    const all = { query: "fr", cookie: "de", stored: "it", acceptLanguage: "ja", browserLanguages: ["tr"] };
    expect(resolveLanguage(all)).toEqual({ lang: "fr", source: "query" });
    expect(resolveLanguage({ ...all, query: null })).toEqual({ lang: "de", source: "cookie" });
    expect(resolveLanguage({ ...all, query: "nope", cookie: null })).toEqual({ lang: "it", source: "stored" });
    expect(resolveLanguage({ ...all, query: null, cookie: null, stored: null })).toEqual({ lang: "ja", source: "browser" });
    expect(resolveLanguage({ browserLanguages: ["nl", "tr-TR"] })).toEqual({ lang: "tr", source: "browser" });
    expect(resolveLanguage({ acceptLanguage: "nl" })).toEqual({ lang: "en", source: "default" });
    expect(resolveLanguage({})).toEqual({ lang: "en", source: "default" });
  });

  it("the extension's zh_TW reaches the page as Traditional Chinese", () => {
    expect(resolveLanguage({ query: "zh-TW" }).lang).toBe("zh-TW");
    expect(resolveLanguage({ query: "zh_TW" }).lang).toBe("zh-TW");
  });

  it("the kaption_lang cookie: path /, SameSite=Lax, a year", () => {
    expect(languageCookie("es")).toBe(`${LANG_COOKIE}=es; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    expect(readCookie("a=1; kaption_lang=zh-TW; b=2", LANG_COOKIE)).toBe("zh-TW");
    expect(readCookie("a=1", LANG_COOKIE)).toBeNull();
  });
});

describe("mcp.CONNECT_CODE.8 server messages", () => {
  it("every message a route answers has a key", () => {
    const routes = sourceFiles(APP_DIR).filter((f) => f.endsWith("route.ts"));
    const messages = new Set<string>();
    for (const file of routes) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/jsonError\(\s*"([^"]+)"/g)) messages.add(m[1]);
      for (const m of source.matchAll(/const \w+ = "([^"]+)";/g)) messages.add(m[1]);
    }
    for (const m of readFileSync(path.join(__dirname, "schemas.ts"), "utf8").matchAll(/, "([A-Z][^"]+)"\)/g)) messages.add(m[1]);
    for (const m of readFileSync(path.join(__dirname, "otp.ts"), "utf8").matchAll(/error: "([^"]+)"/g)) messages.add(m[1]);
    // The extension's revoke call (no page shows it).
    messages.delete("Missing token");
    expect(messages.size).toBeGreaterThan(25);
    expect([...messages].filter((message) => !errorKeyFor(message))).toEqual([]);
  });

  it("keeps the English error and adds its key and values", () => {
    expect(errorBody("Too many tries. Wait a few minutes and try again.")).toEqual({
      error: "Too many tries. Wait a few minutes and try again.",
      errorKey: "err.too_many_tries",
    });
    expect(errorBody("Invalid code. 3 attempts remaining.")).toEqual({
      error: "Invalid code. 3 attempts remaining.",
      errorKey: "err.otp_invalid",
      errorParams: { remaining: "3" },
    });
    expect(errorBody("Something unforeseen")).toEqual({ error: "Something unforeseen" });
  });

  it("the page shows it in its language", () => {
    const t = getT("es");
    expect(translateError(t, errorBody("Invalid code. 3 attempts remaining."), "common.verification_failed")).toBe(
      t("err.otp_invalid", { remaining: 3 }),
    );
    expect(translateError(t, { error: "Something unforeseen" }, "common.verification_failed")).toBe("Something unforeseen");
    expect(translateError(t, {}, "common.verification_failed")).toBe(t("common.verification_failed"));
  });
});
