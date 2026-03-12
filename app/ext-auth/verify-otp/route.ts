/**
 * POST /ext-auth/verify-otp — Verify OTP and return cloud_token for extension.
 *
 * Security: [M7] CSRF, [H1] no key leaks, [L2] sanitized logging.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ExtVerifyOTPSchema } from "@/src/schemas";
import {
  deriveAccountRef,
  verifyOTP,
  generateCloudToken,
  storeExtensionSession,
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

  const parsed = await ExtVerifyOTPSchema.safeParseAsync(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return withCors(Response.json({ error: msg }, { status: 400 }), request);
  }

  const { phone, code } = parsed.data;
  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return withCors(Response.json({ error: "Invalid phone number format" }, { status: 400 }), request);
  }

  const result = await verifyOTP(env.OAUTH_KV, accountRef, code);

  if (!result.valid) {
    return withCors(Response.json({ error: result.error }, { status: 400 }), request);
  }

  // Generate and store a cloud token for the extension
  const cloudToken = generateCloudToken();
  await storeExtensionSession(
    env.OAUTH_KV,
    cloudToken,
    accountRef,
    phone,
    env.EPHEMERAL_STATE_SECRET,
  );

  console.log(`[ext-auth] Session created for ${sanitizeForLog(phone)}`);
  return withCors(Response.json({ ok: true, cloud_token: cloudToken }), request);
}
