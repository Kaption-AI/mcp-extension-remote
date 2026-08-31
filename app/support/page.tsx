import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kaption Extension MCP Support",
  description: "Support and troubleshooting for the Kaption AI plugin and MCP connection.",
};

export default function SupportPage() {
  return (
    <main className="min-h-screen px-5 py-16">
      <div className="mx-auto max-w-3xl">
        <a className="text-sm text-green-400 hover:text-green-300" href="/">
          ← Kaption Extension MCP
        </a>

        <h1 className="mt-8 text-3xl font-bold text-neutral-50">Support</h1>
        <p className="mt-4 leading-relaxed text-neutral-300">
          Need help connecting Kaption to ChatGPT or Codex? Email our support
          team and include the client you are using, the step that failed, and
          any error message shown. Do not send message contents, passwords,
          one-time codes, or authentication tokens.
        </p>

        <div className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="text-lg font-semibold text-neutral-50">Contact</h2>
          <p className="mt-2 text-neutral-400">
            Email: {" "}
            <a className="text-green-400 hover:text-green-300" href="mailto:hello@kaptionai.com">
              hello@kaptionai.com
            </a>
          </p>
          <p className="mt-2 text-sm text-neutral-500">
            Kaption AI LLC, 3149 Jazz St, Round Rock, TX 78664, United States.
          </p>
        </div>

        <h2 className="mt-10 text-xl font-semibold text-neutral-50">Before contacting support</h2>
        <ol className="mt-4 list-decimal space-y-3 pl-6 text-neutral-300">
          <li>Confirm the Kaption extension is installed and WhatsApp Web is open.</li>
          <li>In Kaption settings, enable the cloud MCP connection.</li>
          <li>Reconnect the plugin from ChatGPT or Codex and complete sign-in.</li>
          <li>If the extension shows offline, refresh WhatsApp Web and try again.</li>
        </ol>

        <div className="mt-10 flex flex-wrap gap-4 text-sm">
          <a className="text-green-400 hover:text-green-300" href="https://kaptionai.com/privacy">
            Privacy policy
          </a>
          <a className="text-green-400 hover:text-green-300" href="https://kaptionai.com/terms">
            Terms of service
          </a>
          <a className="text-green-400 hover:text-green-300" href="https://kaptionai.com/extension">
            Extension download
          </a>
        </div>
      </div>
    </main>
  );
}
