"use client";

import { useState } from "react";

type Step = "phone" | "code" | "done";

export default function ExtAuthPage() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [cloudToken, setCloudToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const normalized = phone.replace(/[\s\-\+\(\)]/g, "");

    try {
      const res = await fetch("/ext-auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: normalized }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (data.ok) {
        setPhone(normalized);
        setStep("code");
      } else {
        setError(data.error || "Failed to send code");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/ext-auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const data = (await res.json()) as { cloud_token?: string; error?: string };

      if (data.cloud_token) {
        setCloudToken(data.cloud_token);
        setStep("done");
      } else {
        setError(data.error || "Verification failed");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-5">
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
      <h1 className="text-xl mb-2 text-neutral-50">Kaption Cloud Bridge</h1>
      <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
        Authenticate your extension for cloud MCP relay.
      </p>

      {step === "phone" && (
        <form onSubmit={handleSendOtp}>
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
            {loading ? "Sending..." : "Send Code"}
          </button>
        </form>
      )}

      {step === "code" && (
        <form onSubmit={handleVerifyOtp}>
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
            inputMode="numeric"
            className="w-full px-3.5 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 text-neutral-50 text-2xl tracking-[8px] text-center outline-none focus:border-green-500"
          />

          {error && <p className="text-red-500 text-[13px] mt-2">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg border-none bg-green-500 text-neutral-950 font-semibold text-sm cursor-pointer mt-4 hover:bg-green-600 disabled:opacity-50 disabled:cursor-wait"
          >
            {loading ? "Verifying..." : "Verify"}
          </button>
        </form>
      )}

      {step === "done" && (
        <>
          <p className="text-green-500 text-sm mt-3 font-medium">
            Connected! Copy the token below and paste it into your extension
            settings.
          </p>
          <div className="mt-3 p-3 rounded-lg bg-neutral-950 border border-neutral-800 font-mono text-[13px] break-all text-neutral-400">
            {cloudToken}
          </div>
        </>
      )}
    </div>
    </div>
  );
}
