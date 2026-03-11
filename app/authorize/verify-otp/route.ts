/**
 * POST /authorize/verify-otp — Verify OTP and complete OAuth authorization.
 *
 * Security: [M3] HMAC-verified oauthReqInfo, [M7] CSRF, [H1] no key leaks.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { VerifyOTPSchema } from "@/src/schemas";
import { verifyOTP, hmacVerify, sanitizeForLog } from "@/src/otp";
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

  const parsed = await VerifyOTPSchema.safeParseAsync(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return Response.json({ error: msg }, { status: 400 });
  }

  const { phone, code, oauthReqInfo } = parsed.data;

  const result = await verifyOTP(env.EXT_AUTH_KV, phone, code);

  if (!result.valid) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  // [M3] Verify HMAC signature on oauthReqInfo
  const rawPayload = await hmacVerify(oauthReqInfo, env.INTERNAL_API_KEY);
  if (!rawPayload) {
    return Response.json({ error: "Invalid or tampered OAuth state" }, { status: 400 });
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(atob(rawPayload));
  } catch {
    return Response.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  if (!oauthReq.clientId) {
    return Response.json(
      { error: "Invalid OAuth state: missing clientId" },
      { status: 400 },
    );
  }

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      metadata: {
        label: `WhatsApp ${sanitizeForLog(phone)}`,
      },
      props: {
        phone,
      },
      request: oauthReq,
      scope: oauthReq.scope,
      userId: phone,
    });

    return Response.json({ redirectTo });
  } catch (err) {
    // [H1] Never leak internal error details
    console.error(`[otp] OAuth completion failed for ${sanitizeForLog(phone)}`);
    return Response.json(
      { error: "Authorization failed. Please try again." },
      { status: 500 },
    );
  }
}
