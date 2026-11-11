/**
 * POST /authorize/connect-code — mcp.CONNECT_CODE.3, .5: sign in with a Kaption code instead of the phone number.
 *
 * The code is either pasted ({ code }) or the one the /connect page remembered on this browser ({ remembered: true },
 * read from the HttpOnly cookie). A code works once. It completes the OAuth request exactly like the WhatsApp code
 * does (verify-otp): same account reference, same connection lifetime.
 *
 * Security: [M7] CSRF via Content-Type, HMAC-verified oauthReqInfo, wrong codes limited per address.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  CONNECT_COOKIE,
  connectDeps,
  countFailedRedeem,
  normalizeConnectCode,
  redeemConnectCode,
  redeemLimit,
} from "@/src/connect-code";
import { deriveAccountRef, hmacVerify, sanitizeAccountRefForLog } from "@/src/otp";
import { parseConnectionLifetime } from "@/src/connection-lifetime-options";
import type { Env } from "@/src/types";
import { errorBody, jsonError } from "@/app/i18n";
import { withHeaders } from "@/src/problem";
import { rateLimitHeaders, tooManyRequests } from "@/src/rate-limit";

const EXPIRED = "This code doesn't work any more. Get a new one in Kaption → AI assistants, then paste it here.";

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Invalid content type", { status: 400, code: "invalid_content_type" });
  }
  const { env } = getCloudflareContext() as unknown as { env: Env };
  let body: { code?: unknown; remembered?: unknown; oauthReqInfo?: unknown; connectionLifetime?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", { status: 400, code: "invalid_json" });
  }
  if (typeof body.oauthReqInfo !== "string" || !body.oauthReqInfo) {
    return jsonError("Invalid OAuth state", { status: 400, code: "invalid_oauth_state" });
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  // Only wrong codes count against this limit.
  const limit = await redeemLimit(env.OAUTH_KV, ip);
  if (limit.remaining <= 0) {
    const message = "Too many tries. Wait a few minutes and try again.";
    return tooManyRequests(limit, message, { extra: errorBody(message) });
  }
  let headers = rateLimitHeaders(limit);

  const jar = await cookies();
  const remembered = body.remembered === true;
  const input = remembered ? jar.get(CONNECT_COOKIE)?.value : body.code;
  if (!normalizeConnectCode(input)) {
    if (!remembered) headers = rateLimitHeaders(await countFailedRedeem(env.OAUTH_KV, ip));
    return jsonError(remembered ? EXPIRED : "That doesn't look like a Kaption code. It has 8 letters and numbers, like ABCD-2345.", {
      status: 400,
      code: remembered ? "connect_code_expired" : "connect_code_malformed",
      headers,
      extra: { forget: remembered },
    });
  }

  // [M3] The request is ours before the code is spent.
  const rawPayload = await hmacVerify(body.oauthReqInfo, env.INTERNAL_API_KEY);
  let oauthReq: AuthRequest | null = null;
  try {
    oauthReq = rawPayload ? (JSON.parse(atob(rawPayload)) as AuthRequest) : null;
  } catch {
    oauthReq = null;
  }
  if (!oauthReq?.clientId) {
    return jsonError("Invalid or tampered OAuth state", { status: 400, code: "invalid_oauth_state", headers });
  }

  const phone = await redeemConnectCode(connectDeps(env), input);
  if (remembered) jar.delete(CONNECT_COOKIE);
  if (!phone) {
    headers = rateLimitHeaders(await countFailedRedeem(env.OAUTH_KV, ip));
    return jsonError(EXPIRED, { status: 400, code: "connect_code_expired", headers, extra: { forget: remembered } });
  }
  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return jsonError(EXPIRED, { status: 400, code: "connect_code_expired", headers });
  }

  const connectionLifetime = parseConnectionLifetime(body.connectionLifetime);
  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      metadata: { label: `WhatsApp ${accountRef.slice(0, 13)}`, lifetime: connectionLifetime },
      props: { accountRef, connectionLifetime },
      request: oauthReq,
      scope: oauthReq.scope,
      userId: accountRef,
    });
    return withHeaders(Response.json({ redirectTo }), headers);
  } catch {
    // [H1] Never leak internal error details
    console.error(`[connect-code] OAuth completion failed for ${sanitizeAccountRefForLog(accountRef)}`);
    return jsonError("Authorization failed. Please try again.", { status: 500, code: "authorization_failed", headers });
  }
}
