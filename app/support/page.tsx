import type { Metadata } from "next";
import { getServerT } from "../i18n-server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerT();
  return {
    title: t("support.meta_title"),
    description: t("support.meta_description"),
  };
}

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await getServerT((await searchParams).lang);
  return (
    <main className="min-h-screen px-5 py-16">
      <div className="mx-auto max-w-3xl">
        <a className="text-sm text-green-400 hover:text-green-300" href="/">
          ← Kaption Extension MCP
        </a>

        <h1 className="mt-8 text-3xl font-bold text-neutral-50">{t("support.title")}</h1>
        <p className="mt-4 leading-relaxed text-neutral-300">
          {t("support.intro")}
        </p>

        <div className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="text-lg font-semibold text-neutral-50">{t("support.contact")}</h2>
          <p className="mt-2 text-neutral-400">
            {t("support.email")}{" "}
            <a className="text-green-400 hover:text-green-300" href="mailto:hello@kaptionai.com">
              hello@kaptionai.com
            </a>
          </p>
          <p className="mt-2 text-sm text-neutral-500">
            Kaption AI LLC, 3149 Jazz St, Round Rock, TX 78664, United States.
          </p>
        </div>

        <h2 className="mt-10 text-xl font-semibold text-neutral-50">{t("support.before")}</h2>
        <ol className="mt-4 list-decimal space-y-3 pl-6 text-neutral-300">
          <li>{t("support.step1")}</li>
          <li>{t("support.step2")}</li>
          <li>{t("support.step3")}</li>
          <li>{t("support.step4")}</li>
        </ol>

        <div className="mt-10 flex flex-wrap gap-4 text-sm">
          <a className="text-green-400 hover:text-green-300" href="https://kaptionai.com/privacy">
            {t("support.privacy")}
          </a>
          <a className="text-green-400 hover:text-green-300" href="https://kaptionai.com/terms">
            {t("support.terms")}
          </a>
          <a className="text-green-400 hover:text-green-300" href="https://kaptionai.com/extension">
            {t("support.download")}
          </a>
        </div>
      </div>
    </main>
  );
}
