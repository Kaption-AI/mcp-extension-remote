/**
 * POST /authorize/resend-otp — Resend OTP for OAuth authorization flow.
 *
 * Accepts the existing verifyTicket (which contains encrypted phone + oauthReqInfo),
 * generates a NEW OTP (replacing the old one), sends it via WhatsApp, and returns
 * a fresh verifyTicket.
 *
 * Rate limited: max 3 resends per 10 minutes per account (on top of global limits).
 *
 * Security: [M7] CSRF, [M1] rate limiting, [H1] no key leaks, [L2] sanitized logging.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ResendOTPSchema } from "@/src/schemas";
import {
  createVerifyTicket,
  deriveAccountRef,
  generateOTP,
  otpResendLimit,
  otpIpLimit,
  incrementResendRateLimit,
  incrementIpRateLimit,
  readVerifyTicket,
  storeOTP,
  sanitizeForLog,
} from "@/src/otp";
import type { Env } from "@/src/types";
import { errorBody, jsonError } from "@/app/i18n";
import { withHeaders } from "@/src/problem";
import { consumed, rateLimitHeaders, tooManyRequests } from "@/src/rate-limit";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return jsonError("Invalid content type", { status: 400, code: "invalid_content_type" });
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("Invalid JSON body", { status: 400, code: "invalid_json" });
  }

  const parsed = await ResendOTPSchema.safeParseAsync(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return jsonError(msg, { status: 400, code: "invalid_input" });
  }

  const { verifyTicket } = parsed.data;

  // Decrypt the verify ticket to get phone + oauthReqInfo
  const ticket = await readVerifyTicket(verifyTicket, env.EPHEMERAL_STATE_SECRET);
  if (!ticket) {
    return jsonError("Verification session expired. Please start over.",
      { status: 400, code: "verification_expired" },
    );
  }

  const { phone, oauthReqInfo } = ticket;
  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return jsonError("Invalid session", { status: 400, code: "invalid_session" });
  }

  // IP rate limiting
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipLimit = await otpIpLimit(env.OAUTH_KV, ip);
  if (ipLimit.remaining <= 0) {
    const message = "Too many requests. Try again later.";
    return tooManyRequests(ipLimit, message, { extra: errorBody(message) });
  }

  // Resend-specific rate limit (3 per 10 min)
  const resendLimit = await otpResendLimit(env.OAUTH_KV, accountRef);
  if (resendLimit.remaining <= 0) {
    const message = "Too many resend attempts. Please wait a few minutes.";
    return tooManyRequests(resendLimit, message, { extra: errorBody(message) });
  }
  // Both limits count this request from here on.
  const headers = rateLimitHeaders(consumed(resendLimit), consumed(ipLimit));

  // Generate new OTP (replaces old one in KV)
  const code = generateOTP();
  await storeOTP(env.OAUTH_KV, accountRef, code);
  await incrementResendRateLimit(env.OAUTH_KV, accountRef);
  await incrementIpRateLimit(env.OAUTH_KV, ip);

  // Send via WhatsApp
  try {
    const apiBase = env.INTERNAL_API_BASE_URL.replace(/\/$/, "");
    const res = await fetch(`${apiBase}/__internal/otp/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": env.INTERNAL_API_KEY,
      },
      body: JSON.stringify({ phone, code }),
    });

    if (!res.ok) {
      console.error(`[otp-resend] Send failed for ${sanitizeForLog(phone)}: ${res.status}`);
      return jsonError("Failed to resend code. Try again.",
        { status: 500, code: "otp_send_failed", headers },
      );
    }

    // Create fresh verify ticket (resets the 5-min TTL)
    const newTicket = await createVerifyTicket(
      phone,
      oauthReqInfo,
      env.EPHEMERAL_STATE_SECRET,
    );
    if (!newTicket) {
      return jsonError("Failed to prepare verification flow.", { status: 500, code: "internal_error", headers });
    }

    return withHeaders(Response.json({ ok: true, verifyTicket: newTicket }), headers);
  } catch {
    console.error(`[otp-resend] Send error for ${sanitizeForLog(phone)}`);
    return jsonError("Failed to resend code. Try again.",
      { status: 500, code: "otp_send_failed", headers },
    );
  }
}
