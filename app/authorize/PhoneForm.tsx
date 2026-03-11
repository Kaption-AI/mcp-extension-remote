"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function PhoneForm({ oauthReqInfo }: { oauthReqInfo: string }) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!oauthReqInfo) {
    return (
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
        <h1 className="text-xl mb-2 text-neutral-50">Invalid Request</h1>
        <p className="text-sm text-neutral-400">
          Missing authorization state. Please start the OAuth flow from your MCP
          client.
        </p>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const normalized = phone.replace(/[\s\-\+\(\)]/g, "");

    try {
      const res = await fetch("/authorize/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: normalized, oauthReqInfo }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (data.ok) {
        router.push(
          `/authorize/verify?phone=${encodeURIComponent(normalized)}&oauthReqInfo=${encodeURIComponent(oauthReqInfo)}`,
        );
      } else {
        setError(data.error || "Failed to send code");
        setLoading(false);
      }
    } catch {
      setError("Network error. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
      <h1 className="text-xl mb-2 text-neutral-50">Kaption MCP</h1>
      <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
        Sign in with your WhatsApp number to connect AI tools to your
        conversations.
      </p>

      <form onSubmit={handleSubmit}>
        <label
          htmlFor="phone"
          className="block text-[13px] text-neutral-400 mb-1.5"
        >
          WhatsApp Phone Number
        </label>
        <input
          type="tel"
          id="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="5491157390064"
          required
          autoComplete="tel"
          className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-base outline-none focus:border-green-500"
        />
        <p className="text-xs text-neutral-500 mt-1.5">
          Enter your full number without + or spaces (e.g. 5491157390064)
        </p>

        {error && <p className="text-red-500 text-[13px] mt-2">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-lg border-none bg-green-500 text-neutral-950 font-semibold text-sm cursor-pointer mt-4 hover:bg-green-600 disabled:opacity-50 disabled:cursor-wait"
        >
          {loading ? "Sending..." : "Send Verification Code"}
        </button>
      </form>
    </div>
  );
}
