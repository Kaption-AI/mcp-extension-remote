import type { Metadata } from "next";
import "./globals.css";
import { LanguageProvider } from "./LanguageProvider";
import { getServerLanguage } from "./i18n-server";

export const metadata: Metadata = {
  title: "Kaption MCP",
  description: "Cloud MCP relay for WhatsApp",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // mcp.CONNECT_CODE.8 — <html lang> and every page's text follow the same choice.
  const { lang, source } = await getServerLanguage();
  return (
    <html lang={lang}>
      <body className="min-h-screen bg-neutral-950 text-neutral-200 font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',Roboto,sans-serif]">
        <LanguageProvider initial={lang} source={source}>
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
