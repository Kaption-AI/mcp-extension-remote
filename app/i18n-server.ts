/**
 * mcp.CONNECT_CODE.8 — the page language on the server (layout, server components): the `lang` query param (passed on
 * by the Worker as x-kaption-lang, or given directly by a page), the kaption_lang cookie, Accept-Language, English.
 * The browser's stored language can only be read on the client; LanguageProvider applies it there.
 */
import { cookies, headers } from "next/headers";
import { getT, type TFunc } from "./i18n";
import { LANG_COOKIE, LANG_HEADER, resolveLanguage, type LanguageCode, type LanguageSource } from "./language";

export async function getServerLanguage(query?: string | string[] | null): Promise<{ lang: LanguageCode; source: LanguageSource }> {
  let headerList: Headers | null = null;
  let cookie: string | null = null;
  try {
    headerList = await headers();
    cookie = (await cookies()).get(LANG_COOKIE)?.value ?? null;
  } catch {
    // Outside a request (static generation): English.
  }
  return resolveLanguage({
    query: (typeof query === "string" ? query : null) ?? headerList?.get(LANG_HEADER) ?? null,
    cookie,
    acceptLanguage: headerList?.get("accept-language") ?? null,
  });
}

export async function getServerT(query?: string | string[] | null): Promise<{ lang: LanguageCode; t: TFunc }> {
  const { lang } = await getServerLanguage(query);
  return { lang, t: getT(lang) };
}
