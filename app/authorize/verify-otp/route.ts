/**
 * POST /authorize/verify-otp — Verify OTP and complete OAuth authorization.
 *
 * Security: [M3] HMAC-verified oauthReqInfo, [M7] CSRF, [H1] no key leaks.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { VerifyOTPSchema } from "@/src/schemas";
import {
  deriveAccountRef,
  hmacVerify,
  readVerifyTicket,
  sanitizeForLog,
  verifyOTP,
} from "@/src/otp";
import type { Env } from "@/src/types";
import { DEFAULT_CONNECTION_LIFETIME } from "@/src/connection-lifetime-options";
import { jsonError } from "@/app/i18n";
import { anotherAppMetadata, audit, gateSignIn, RATE_LIMITED_MESSAGE, takeConnection } from "@/src/another-app";

export async function POST(request: Request): Promise<Response> {
  // [M7] Validate Content-Type
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

  const parsed = await VerifyOTPSchema.safeParseAsync(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return jsonError(msg, { status: 400, code: "invalid_input" });
  }

  const { verifyTicket, code } = parsed.data;
  // mcp.CLOUD_RELAY.9 — the lifetime picked on the consent page
  const connectionLifetime = parsed.data.connectionLifetime ?? DEFAULT_CONNECTION_LIFETIME;
  const ticket = await readVerifyTicket(verifyTicket, env.EPHEMERAL_STATE_SECRET);
  if (!ticket) {
    return jsonError("Verification session expired. Request a new code.", { status: 400, code: "verification_expired" });
  }

  const { phone, oauthReqInfo } = ticket;
  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return jsonError("Invalid phone number format", { status: 400, code: "invalid_phone" });
  }

  // mcp.ANOTHER_APP.6-7 — the ticket exists only because send-otp saw the tick; the switch and the phone are checked
  // again here (the owner may have turned it off in between). A known app's request passes straight through.
  const gate = await gateSignIn(env, oauthReqInfo, { trusted: true, phone });
  if (gate?.kind === "refused") {
    await audit(env.OAUTH_KV, { event: "refused", accountRef, reason: gate.code });
    return jsonError(gate.message, { status: gate.status, code: gate.code });
  }
  const anotherAppHost = gate?.kind === "unknown" ? gate.host : null;

  const result = await verifyOTP(env.OAUTH_KV, accountRef, code);

  if (!result.valid) {
    return jsonError(result.error, { status: 400, code: result.code });
  }

  // [M3] Verify HMAC signature on oauthReqInfo
  const rawPayload = await hmacVerify(oauthReqInfo, env.INTERNAL_API_KEY);
  if (!rawPayload) {
    return jsonError("Invalid or tampered OAuth state", { status: 400, code: "invalid_oauth_state" });
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(atob(rawPayload));
  } catch {
    return jsonError("Invalid OAuth state", { status: 400, code: "invalid_oauth_state" });
  }

  if (!oauthReq.clientId) {
    return jsonError("Invalid OAuth state: missing clientId",
      { status: 400, code: "invalid_oauth_state" },
    );
  }

  // mcp.ANOTHER_APP.11 — at most a few new unknown websites per account a day.
  if (anotherAppHost && !(await takeConnection(env.OAUTH_KV, accountRef)).allowed) {
    await audit(env.OAUTH_KV, { event: "refused", host: anotherAppHost, clientId: oauthReq.clientId, accountRef, reason: "rate_limited" });
    return jsonError(RATE_LIMITED_MESSAGE, { status: 429, code: "another_app_rate_limited" });
  }
  // mcp.ANOTHER_APP.8 — an unknown website's connection always ends after 90 days without use.
  const lifetime = anotherAppHost ? "inactive-90d" : connectionLifetime;

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      // `metadata.lifetime` is readable without decrypting the grant (the
      // relay's idle check and the connections list use it); `props` carries
      // it into the token-exchange callback that sets the library lifetime.
      metadata: {
        label: `WhatsApp ${accountRef.slice(0, 13)}`,
        lifetime,
        ...(anotherAppHost ? anotherAppMetadata(anotherAppHost) : {}),
      },
      props: {
        accountRef,
        connectionLifetime: lifetime,
      },
      request: oauthReq,
      scope: oauthReq.scope,
      userId: accountRef,
    });

    if (anotherAppHost) await audit(env.OAUTH_KV, { event: "approved", host: anotherAppHost, clientId: oauthReq.clientId, accountRef });
    return Response.json({ redirectTo });
  } catch (err) {
    // [H1] Never leak internal error details
    console.error(`[otp] OAuth completion failed for ${sanitizeForLog(phone)}`);
    return jsonError("Authorization failed. Please try again.",
      { status: 500, code: "authorization_failed" },
    );
  }
}
