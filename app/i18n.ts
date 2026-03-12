import en from "./locales/en.json";
import es from "./locales/es.json";
import pt from "./locales/pt.json";
import it from "./locales/it.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import tr from "./locales/tr.json";
import zh from "./locales/zh.json";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "it", label: "Italiano" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "tr", label: "Türkçe" },
  { code: "zh", label: "中文" },
] as const;

const resources: Record<string, Record<string, string>> = {
  en, es, pt, it, de, fr, tr, zh,
};

export type TFunc = (key: string) => string;

const SUPPORTED = new Set(LANGUAGES.map((l) => l.code));

/** Detect language from localStorage or navigator. */
export function detectLanguage(): string {
  if (typeof window === "undefined") return "en";
  try {
    const stored = localStorage.getItem("language");
    if (stored && SUPPORTED.has(stored)) return stored;
  } catch {}
  const nav = navigator.language?.split("-")[0];
  if (nav && SUPPORTED.has(nav)) return nav;
  return "en";
}

/** Get a translation function for a given language. */
export function getT(lang: string): TFunc {
  const dict = resources[lang] || resources.en;
  const fallback = resources.en;
  return (key: string) => dict[key] ?? fallback[key] ?? key;
}
