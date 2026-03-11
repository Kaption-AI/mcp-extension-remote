/**
 * POST /authorize/send-otp — Send OTP for OAuth authorization flow.
 *
 * Security: [M7] CSRF via Content-Type + Origin validation, [M1] IP rate limiting, [H1] no key leaks.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { SendOTPSchema } from "@/src/schemas";
import {
  generateOTP,
  checkCooldown,
  setCooldown,
  checkRateLimit,
  incrementRateLimit,
  checkIpRateLimit,
  incrementIpRateLimit,
  storeOTP,
  sanitizeForLog,
} from "@/src/otp";
import type { Env } from "@/src/types";

export async function POST(request: Request): Promise<Response> {
  // [M7] Validate Content-Type
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

  const parsed = await SendOTPSchema.safeParseAsync(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return Response.json({ error: msg }, { status: 400 });
  }

  const { phone } = parsed.data;

  // [M1] IP-based rate limiting
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await checkIpRateLimit(env.AUTH_KV, ip))) {
    return Response.json(
      { error: "Too many requests. Try again later." },
      { status: 429 },
    );
  }

  // Check cooldown (60s between sends)
  if (await checkCooldown(env.AUTH_KV, phone)) {
    return Response.json(
      { error: "Please wait 60 seconds before requesting a new code" },
      { status: 429 },
    );
  }

  // Check hourly rate limit
  if (!(await checkRateLimit(env.AUTH_KV, phone))) {
    return Response.json(
      { error: "Too many OTP requests. Try again in an hour." },
      { status: 429 },
    );
  }

  // Generate and store OTP
  const code = generateOTP();
  await storeOTP(env.AUTH_KV, phone, code);
  await setCooldown(env.AUTH_KV, phone);
  await incrementRateLimit(env.AUTH_KV, phone);
  await incrementIpRateLimit(env.AUTH_KV, ip);

  // Send OTP via rest-api → WhatsApp Cloud API
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
      // [H1] Never leak internal details
      console.error(`[otp] Send failed for ${sanitizeForLog(phone)}: ${res.status}`);
      return Response.json(
        { error: "Failed to send verification code. Try again." },
        { status: 500 },
      );
    }

    return Response.json({ ok: true });
  } catch (err) {
    // [H1] + [L2] Sanitize error logging
    console.error(`[otp] Send error for ${sanitizeForLog(phone)}`);
    return Response.json(
      { error: "Failed to send verification code. Try again." },
      { status: 500 },
    );
  }
}
