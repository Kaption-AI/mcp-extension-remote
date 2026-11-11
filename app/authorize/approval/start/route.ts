/**
 * POST /authorize/approval/start — mcp.ANY_CLIENT.5: "Sign in with Kaption on this computer" begins. The sign-in page
 * sends the signed OAuth request it shows; this creates an approval request bound to that client, redirect and PKCE
 * challenge, and to this browser (an HttpOnly cookie; only its SHA-256 is stored). The page then hands the id to the
 * Kaption extension in this browser.
 *
 * Security: [M7] CSRF via Content-Type, [M3] HMAC-verified oauthReqInfo, 10 per address in 10 minutes.
 */
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { APPROVAL_START_IP_POLICY, APPROVAL_TTL_SECONDS, createApproval } from "@/src/approval";
import { connectDeps } from "@/src/connect-code";
import { approvalNeedsPkce } from "@/src/redirect-policy";
import { readSignedRequest, requestKind } from "@/src/signed-request";
import { readSlidingCounter, rateLimitHeaders, slidingStatus, tooManyRequests, writeSlidingCounter } from "@/src/rate-limit";
import { withHeaders } from "@/src/problem";
import type { Env } from "@/src/types";
import { errorBody, jsonError } from "@/app/i18n";
import { approvalCookieName } from "../cookie";

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Invalid content type", { status: 400, code: "invalid_content_type" });
  }
  const { env } = getCloudflareContext() as unknown as { env: Env };
  let body: { oauthReqInfo?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", { status: 400, code: "invalid_json" });
  }

  // mcp.ANY_CLIENT.5 — at most 10 approval requests per address in 10 minutes.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const p = APPROVAL_START_IP_POLICY;
  const counterKey = `rate:approval-start:${ip}`;
  const counter = await readSlidingCounter(env.OAUTH_KV, counterKey);
  const limit = slidingStatus(counter, p.name, p.limit, p.windowSeconds);
  if (limit.remaining <= 0) {
    const message = "Too many requests. Try again later.";
    return tooManyRequests(limit, message, { extra: errorBody(message) });
  }

  const oauthReq = await readSignedRequest(body.oauthReqInfo, env);
  if (!oauthReq) return jsonError("Invalid or tampered OAuth state", { status: 400, code: "invalid_oauth_state" });
  const kind = await requestKind(env, oauthReq);
  if (!kind) {
    return jsonError("Kaption doesn't connect to this app.", { status: 403, code: "unauthorized_client" });
  }
  // mcp.ANY_CLIENT.5 — everything that isn't a known AI app's website must prove it is the app that asked (PKCE S256).
  if (approvalNeedsPkce(kind) && (!oauthReq.codeChallenge || oauthReq.codeChallengeMethod !== "S256")) {
    return jsonError("This app didn't use PKCE (S256), so Kaption can't approve it.", { status: 400, code: "pkce_required" });
  }

  await writeSlidingCounter(env.OAUTH_KV, counterKey, counter.count + 1, p.windowSeconds);
  const headers = rateLimitHeaders({ ...limit, remaining: limit.remaining - 1 });

  let appName: string | null = null;
  try {
    appName = (await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId))?.clientName?.trim() || null;
  } catch {
    appName = null;
  }
  const created = await createApproval(connectDeps(env), { request: oauthReq, kind, appName });
  (await cookies()).set(approvalCookieName(created.id), created.browserSecret, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/authorize",
    maxAge: APPROVAL_TTL_SECONDS,
  });
  return withHeaders(Response.json({ requestId: created.id, expiresAt: created.expiresAt, kind }), headers);
}
