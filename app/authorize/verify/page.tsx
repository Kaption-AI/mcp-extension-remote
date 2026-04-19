"use client";

import { useSearchParams } from "next/navigation";
import { useState, useEffect, useCallback, Suspense } from "react";

const RESEND_COOLDOWN_SECONDS = 60;

function OTPForm() {
  const searchParams = useSearchParams();
  const initialTicket = searchParams.get("ticket") || "";
  const [ticket, setTicket] = useState(initialTicket);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState("");

  // Countdown timer for resend cooldown
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleResend = useCallback(async () => {
    if (resendCooldown > 0 || resending || !ticket) return;
    setResending(true);
    setResendMessage("");
    setError("");

    try {
      const res = await fetch("/authorize/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verifyTicket: ticket }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        verifyTicket?: string;
        error?: string;
      };

      if (data.ok && data.verifyTicket) {
        setTicket(data.verifyTicket);
        setResendCooldown(RESEND_COOLDOWN_SECONDS);
        setResendMessage("Code sent! Check your WhatsApp.");
      } else {
        setError(data.error || "Failed to resend code.");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setResending(false);
    }
  }, [resendCooldown, resending, ticket]);

  if (!initialTicket) {
    return (
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
        <h1 className="text-xl mb-2 text-neutral-50">Invalid Request</h1>
        <p className="text-sm text-neutral-400">
          Missing verification session. Go back and try again.
        </p>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/authorize/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verifyTicket: ticket, code }),
      });
      const data = (await res.json()) as { redirectTo?: string; error?: string };

      if (data.redirectTo) {
        window.location.href = data.redirectTo;
      } else {
        setError(data.error || "Verification failed");
        setLoading(false);
      }
    } catch {
      setError("Network error. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
      <h1 className="text-xl mb-2 text-neutral-50">Enter Verification Code</h1>
      <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
        We sent a 6-digit code to your WhatsApp number.
      </p>

      <form onSubmit={handleSubmit}>
        <label
          htmlFor="code"
          className="block text-[13px] text-neutral-400 mb-1.5"
        >
          Verification Code
        </label>
        <input
          type="text"
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={6}
          pattern="[0-9]{6}"
          required
          autoComplete="one-time-code"
          inputMode="numeric"
          className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-2xl tracking-[8px] text-center outline-none focus:border-green-500"
        />

        {error && <p className="text-red-500 text-[13px] mt-2">{error}</p>}
        {resendMessage && (
          <p className="text-green-400 text-[13px] mt-2">{resendMessage}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-lg border-none bg-green-500 text-neutral-950 font-semibold text-sm cursor-pointer mt-4 hover:bg-green-600 disabled:opacity-50 disabled:cursor-wait"
        >
          {loading ? "Verifying..." : "Verify"}
        </button>
      </form>

      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => history.back()}
          className="text-neutral-400 text-[13px] bg-transparent border-none cursor-pointer hover:text-neutral-50"
        >
          &larr; Different number
        </button>

        <button
          onClick={handleResend}
          disabled={resendCooldown > 0 || resending}
          className="text-[13px] bg-transparent border-none cursor-pointer disabled:opacity-40 disabled:cursor-default text-green-400 hover:text-green-300 disabled:text-neutral-500"
        >
          {resending
            ? "Sending..."
            : resendCooldown > 0
              ? `Resend code (${resendCooldown}s)`
              : "Resend code"}
        </button>
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <div className="flex items-center justify-center min-h-screen p-5">
      <Suspense
        fallback={
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
            <p className="text-neutral-400">Loading...</p>
          </div>
        }
      >
        <OTPForm />
      </Suspense>
    </div>
  );
}
