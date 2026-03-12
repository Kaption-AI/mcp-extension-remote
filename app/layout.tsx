import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kaption MCP",
  description: "Cloud MCP relay for WhatsApp",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-200 font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',Roboto,sans-serif]">
        {children}
      </body>
    </html>
  );
}
