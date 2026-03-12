"use client";

import { useState, useEffect, useCallback } from "react";
import { LANGUAGES, detectLanguage, getT, type TFunc } from "./i18n";

const EXTENSION_URL = "https://kaptionai.com/extension";
const GITHUB_URL = "https://github.com/Kaption-AI/mcp-extension-remote";
const CHROME_URL = "https://chromewebstore.google.com/detail/audio-to-text-in-whatsapp/iinbhdejcemjafkabjokgeaffgnmijbh";
const EDGE_URL = "https://microsoftedge.microsoft.com/addons/detail/audio-to-text-in-whatsapp/gdgohknecjblcncbokbhpaebebmeiidk";
const FIREFOX_URL = "https://addons.mozilla.org/firefox/addon/audio-to-text-for-whatsapp-web/";
const LOCAL_MCP_DOCS = "https://www.npmjs.com/package/@kaptionai/mcp-extension";
const TRANSPARENCY_URL = "https://mcp-ext.kaptionai.com/transparency/latest";

export default function LandingPage() {
  const [lang, setLangState] = useState("en");
  const t = getT(lang);

  useEffect(() => {
    setLangState(detectLanguage());
  }, []);

  const setLang = useCallback((code: string) => {
    setLangState(code);
    try { localStorage.setItem("language", code); } catch {}
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <Header lang={lang} setLang={setLang} />
      <main className="flex-1">
        <Hero t={t} />
        <PrivacyBanner t={t} />
        <SetupOptions t={t} />
        <HowItWorks t={t} />
        <ExtensionStores t={t} />
        <VerifiedDeploys t={t} />
      </main>
      <Footer t={t} />
    </div>
  );
}

function Header({ lang, setLang }: { lang: string; setLang: (code: string) => void }) {
  return (
    <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <img src="/icon.png" alt="Kaption" width={28} height={28} className="rounded-md" />
          <span className="font-semibold text-neutral-50 text-lg">Kaption Extension MCP</span>
        </div>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className="bg-neutral-800 border border-neutral-700 text-neutral-300 text-sm rounded-lg px-2 py-1.5 outline-none focus:border-green-500 cursor-pointer"
          aria-label="Language"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </div>
    </header>
  );
}

function Hero({ t }: { t: TFunc }) {
  return (
    <section className="text-center py-16 md:py-24 px-5">
      <h1 className="text-3xl md:text-5xl font-bold text-neutral-50 mb-6 leading-tight">
        {t("hero_title")}
      </h1>
      <p className="text-lg md:text-xl text-neutral-400 max-w-2xl mx-auto mb-10 leading-relaxed">
        {t("hero_subtitle")}
      </p>
      <div className="flex flex-col sm:flex-row gap-4 justify-center">
        <a href={EXTENSION_URL} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-green-500 text-neutral-950 font-semibold text-sm hover:bg-green-600 transition-colors">
          {t("install_extension")}
        </a>
        <a href="#setup"
          className="inline-flex items-center justify-center px-6 py-3 rounded-lg border border-neutral-700 text-neutral-300 font-medium text-sm hover:border-neutral-500 transition-colors">
          {t("learn_more")} ↓
        </a>
      </div>
    </section>
  );
}

function PrivacyBanner({ t }: { t: TFunc }) {
  return (
    <section className="px-5 pb-16">
      <div className="max-w-3xl mx-auto bg-neutral-900 border border-neutral-800 rounded-xl p-8">
        <h2 className="text-xl font-semibold text-neutral-50 mb-3 flex items-center gap-2">
          <span role="img" aria-label="shield">🛡</span>
          {t("privacy_title")}
        </h2>
        <p className="text-neutral-400 leading-relaxed mb-5">{t("privacy_body")}</p>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"
          className="text-green-400 hover:text-green-300 text-sm font-medium transition-colors">
          {t("view_source")} →
        </a>
      </div>
    </section>
  );
}

function SetupOptions({ t }: { t: TFunc }) {
  return (
    <section id="setup" className="px-5 pb-16 scroll-mt-20">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-2xl font-bold text-neutral-50 mb-8">{t("setup_title")}</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-7 flex flex-col">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-xl" role="img" aria-label="cloud">☁️</span>
              <h3 className="text-lg font-semibold text-neutral-50">{t("cloud_title")}</h3>
            </div>
            <span className="text-xs font-medium text-green-400 mb-4 ml-8">★ {t("cloud_badge")}</span>
            <p className="text-neutral-400 text-sm leading-relaxed mb-4">{t("cloud_desc")}</p>
            <p className="text-neutral-500 text-sm leading-relaxed mb-6">{t("cloud_privacy")}</p>
            <div className="mt-auto">
              <a href={EXTENSION_URL} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center px-5 py-2.5 rounded-lg bg-green-500 text-neutral-950 font-semibold text-sm hover:bg-green-600 transition-colors">
                {t("cloud_cta")} →
              </a>
            </div>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-7 flex flex-col">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-xl" role="img" aria-label="computer">💻</span>
              <h3 className="text-lg font-semibold text-neutral-50">{t("local_title")}</h3>
            </div>
            <span className="text-xs font-medium text-neutral-500 mb-4 ml-8">{t("local_badge")}</span>
            <p className="text-neutral-400 text-sm leading-relaxed mb-4">{t("local_desc")}</p>
            <p className="text-neutral-500 text-sm leading-relaxed mb-4">{t("local_privacy")}</p>
            <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 mb-6 font-mono text-xs text-neutral-400 overflow-x-auto">
              npx -y @kaptionai/mcp-extension@latest
            </div>
            <div className="mt-auto">
              <a href={LOCAL_MCP_DOCS} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center px-5 py-2.5 rounded-lg border border-neutral-700 text-neutral-300 font-medium text-sm hover:border-neutral-500 transition-colors">
                {t("local_cta")} →
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks({ t }: { t: TFunc }) {
  const steps = [
    { num: "①", title: t("step1_title"), desc: t("step1_desc") },
    { num: "②", title: t("step2_title"), desc: t("step2_desc") },
    { num: "③", title: t("step3_title"), desc: t("step3_desc") },
  ];
  return (
    <section className="px-5 pb-16">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-2xl font-bold text-neutral-50 mb-10">{t("how_title")}</h2>
        <div className="grid sm:grid-cols-3 gap-8">
          {steps.map((step) => (
            <div key={step.num} className="text-center">
              <div className="text-4xl text-green-400 mb-3">{step.num}</div>
              <h3 className="text-lg font-semibold text-neutral-50 mb-2">{step.title}</h3>
              <p className="text-neutral-400 text-sm leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ExtensionStores({ t }: { t: TFunc }) {
  const stores = [
    { label: t("chrome"), href: CHROME_URL },
    { label: t("edge"), href: EDGE_URL },
    { label: t("firefox"), href: FIREFOX_URL },
  ];
  return (
    <section className="px-5 pb-16">
      <div className="max-w-5xl mx-auto text-center">
        <h2 className="text-2xl font-bold text-neutral-50 mb-8">{t("extension_title")}</h2>
        <div className="flex flex-wrap gap-4 justify-center mb-6">
          {stores.map((store) => (
            <a key={store.label} href={store.href} target="_blank" rel="noopener noreferrer"
              className="px-6 py-3 rounded-lg border border-neutral-700 text-neutral-300 font-medium text-sm hover:border-neutral-500 hover:text-neutral-100 transition-colors">
              {store.label}
            </a>
          ))}
        </div>
        <a href={EXTENSION_URL} target="_blank" rel="noopener noreferrer"
          className="text-green-400 hover:text-green-300 text-sm transition-colors">
          kaptionai.com/extension →
        </a>
      </div>
    </section>
  );
}

function VerifiedDeploys({ t }: { t: TFunc }) {
  return (
    <section className="px-5 pb-16">
      <div className="max-w-3xl mx-auto bg-neutral-900 border border-neutral-800 rounded-xl p-8">
        <h2 className="text-xl font-semibold text-neutral-50 mb-3 flex items-center gap-2">
          <span className="text-green-400">✓</span>
          {t("verified_title")}
        </h2>
        <p className="text-neutral-400 leading-relaxed mb-5">{t("verified_body")}</p>
        <div className="flex flex-wrap gap-4">
          <a href={TRANSPARENCY_URL} target="_blank" rel="noopener noreferrer"
            className="text-green-400 hover:text-green-300 text-sm font-medium transition-colors">
            {t("view_deploy")} →
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"
            className="text-green-400 hover:text-green-300 text-sm font-medium transition-colors">
            {t("github_repo")} →
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer({ t }: { t: TFunc }) {
  return (
    <footer className="border-t border-neutral-800 py-8 px-5">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-center gap-2 text-sm text-neutral-500">
        <a href="https://kaptionai.com" target="_blank" rel="noopener noreferrer"
          className="hover:text-neutral-300 transition-colors">
          Kaption AI
        </a>
        <span>·</span>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"
          className="hover:text-neutral-300 transition-colors">
          GitHub
        </a>
        <span>·</span>
        <span>{t("footer_open_source")}</span>
      </div>
    </footer>
  );
}
