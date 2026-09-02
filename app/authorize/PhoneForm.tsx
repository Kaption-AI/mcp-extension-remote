"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function PhoneForm({ oauthReqInfo, loginHint = "" }: { oauthReqInfo: string; loginHint?: string }) {
  const router = useRouter();
  const [phone, setPhone] = useState(loginHint);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reviewUsername, setReviewUsername] = useState("");
  const [reviewPassword, setReviewPassword] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);

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

  async function handleReviewerSubmit(e: React.FormEvent) {
    e.preventDefault();
    setReviewLoading(true);
    setReviewError("");

    try {
      const res = await fetch("/authorize/reviewer-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: reviewUsername,
          password: reviewPassword,
          oauthReqInfo,
        }),
      });
      const data = (await res.json()) as { redirectTo?: string; error?: string };
      if (res.ok && data.redirectTo) {
        window.location.assign(data.redirectTo);
        return;
      }
      setReviewError(data.error || "Reviewer sign-in failed");
    } catch {
      setReviewError("Network error. Try again.");
    } finally {
      setReviewLoading(false);
    }
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
      const data = (await res.json()) as { ok?: boolean; verifyTicket?: string; error?: string };

      if (data.ok && data.verifyTicket) {
        router.push(
          `/authorize/verify?ticket=${encodeURIComponent(data.verifyTicket)}`,
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
          placeholder="1234567890"
          required
          autoComplete="tel"
          className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-base outline-none focus:border-green-500"
        />
        <p className="text-xs text-neutral-500 mt-1.5">
          Enter your full number without + or spaces
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

      <details className="mt-6 border-t border-neutral-800 pt-5">
        <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-300">
          OpenAI reviewer access
        </summary>
        <form onSubmit={handleReviewerSubmit} className="mt-4">
          <label htmlFor="review-username" className="block text-[13px] text-neutral-400 mb-1.5">
            Reviewer username
          </label>
          <input
            id="review-username"
            type="text"
            value={reviewUsername}
            onChange={(e) => setReviewUsername(e.target.value)}
            required
            autoComplete="username"
            className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-base outline-none focus:border-green-500"
          />
          <label htmlFor="review-password" className="block text-[13px] text-neutral-400 mb-1.5 mt-3">
            Reviewer password
          </label>
          <input
            id="review-password"
            type="password"
            value={reviewPassword}
            onChange={(e) => setReviewPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-base outline-none focus:border-green-500"
          />
          {reviewError && <p className="text-red-500 text-[13px] mt-2">{reviewError}</p>}
          <button
            type="submit"
            disabled={reviewLoading}
            className="w-full py-2.5 rounded-lg border border-neutral-700 bg-neutral-800 text-neutral-100 font-semibold text-sm cursor-pointer mt-4 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-wait"
          >
            {reviewLoading ? "Signing in..." : "Reviewer Sign In"}
          </button>
        </form>
      </details>
    </div>
  );
}
