/**
 * POST /ext-auth/send-otp — Send OTP for extension authentication.
 *
 * Security: [M7] CSRF, [M1] IP rate limiting, [H1] no key leaks, [L2] sanitized logging.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ExtSendOTPSchema } from "@/src/schemas";
import {
  generateOTP,
  checkRateLimit,
  incrementRateLimit,
  checkIpRateLimit,
  incrementIpRateLimit,
  storeOTP,
  sanitizeForLog,
} from "@/src/otp";
import type { Env } from "@/src/types";
import { corsOptions, withCors } from "../cors";

export async function OPTIONS(request: Request): Promise<Response> {
  return corsOptions(request);
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return withCors(Response.json({ error: "Invalid content type" }, { status: 400 }), request);
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return withCors(Response.json({ error: "Invalid JSON body" }, { status: 400 }), request);
  }

  const parsed = await ExtSendOTPSchema.safeParseAsync(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return withCors(Response.json({ error: msg }, { status: 400 }), request);
  }

  const { phone } = parsed.data;

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await checkIpRateLimit(env.OAUTH_KV, ip))) {
    return withCors(
      Response.json({ error: "Too many requests. Try again later." }, { status: 429 }),
      request,
    );
  }

  if (!(await checkRateLimit(env.OAUTH_KV, phone))) {
    return withCors(
      Response.json({ error: "Too many OTP requests. Try again in an hour." }, { status: 429 }),
      request,
    );
  }

  const code = generateOTP();
  await storeOTP(env.OAUTH_KV, phone, code);
  await incrementRateLimit(env.OAUTH_KV, phone);
  await incrementIpRateLimit(env.OAUTH_KV, ip);

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
      console.error(`[otp] Send failed for ${sanitizeForLog(phone)}: ${res.status}`);
      return withCors(
        Response.json({ error: "Failed to send verification code. Try again." }, { status: 500 }),
        request,
      );
    }

    return withCors(Response.json({ ok: true }), request);
  } catch {
    console.error(`[otp] Send error for ${sanitizeForLog(phone)}`);
    return withCors(
      Response.json({ error: "Failed to send verification code. Try again." }, { status: 500 }),
      request,
    );
  }
}
