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
  checkResendRateLimit,
  incrementResendRateLimit,
  checkIpRateLimit,
  incrementIpRateLimit,
  readVerifyTicket,
  storeOTP,
  sanitizeForLog,
} from "@/src/otp";
import type { Env } from "@/src/types";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return Response.json({ error: "Invalid content type" }, { status: 400 });
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = await ResendOTPSchema.safeParseAsync(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return Response.json({ error: msg }, { status: 400 });
  }

  const { verifyTicket } = parsed.data;

  // Decrypt the verify ticket to get phone + oauthReqInfo
  const ticket = await readVerifyTicket(verifyTicket, env.EPHEMERAL_STATE_SECRET);
  if (!ticket) {
    return Response.json(
      { error: "Verification session expired. Please start over." },
      { status: 400 },
    );
  }

  const { phone, oauthReqInfo } = ticket;
  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return Response.json({ error: "Invalid session" }, { status: 400 });
  }

  // IP rate limiting
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await checkIpRateLimit(env.OAUTH_KV, ip))) {
    return Response.json(
      { error: "Too many requests. Try again later." },
      { status: 429 },
    );
  }

  // Resend-specific rate limit (3 per 10 min)
  if (!(await checkResendRateLimit(env.OAUTH_KV, accountRef))) {
    return Response.json(
      { error: "Too many resend attempts. Please wait a few minutes." },
      { status: 429 },
    );
  }

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
      return Response.json(
        { error: "Failed to resend code. Try again." },
        { status: 500 },
      );
    }

    // Create fresh verify ticket (resets the 5-min TTL)
    const newTicket = await createVerifyTicket(
      phone,
      oauthReqInfo,
      env.EPHEMERAL_STATE_SECRET,
    );
    if (!newTicket) {
      return Response.json({ error: "Failed to prepare verification flow." }, { status: 500 });
    }

    return Response.json({ ok: true, verifyTicket: newTicket });
  } catch {
    console.error(`[otp-resend] Send error for ${sanitizeForLog(phone)}`);
    return Response.json(
      { error: "Failed to resend code. Try again." },
      { status: 500 },
    );
  }
}
