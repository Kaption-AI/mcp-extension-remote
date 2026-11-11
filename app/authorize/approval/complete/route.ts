/**
 * POST /authorize/approval/complete — mcp.ANY_CLIENT.11: Kaption approved the request on the person's computer;
 * complete the OAuth request, once, exactly as the WhatsApp code does (same account reference, same connection
 * lifetime). Only this browser's approved request, for exactly the client, redirect and PKCE challenge it was made for.
 *
 * Security: [M7] CSRF via Content-Type, [M3] HMAC-verified oauthReqInfo, the browser cookie, single use.
 */
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { isApprovalId, recordApprovalAudit, takeApproval } from "@/src/approval";
import { connectDeps } from "@/src/connect-code";
import { deriveAccountRef, sanitizeAccountRefForLog } from "@/src/otp";
import { DEFAULT_CONNECTION_LIFETIME, parseConnectionLifetime } from "@/src/connection-lifetime-options";
import { approvalAllowedForPhone, loadRedirectPolicy } from "@/src/redirect-policy";
import { readSignedRequest, requestKind } from "@/src/signed-request";
import type { Env } from "@/src/types";
import { jsonError } from "@/app/i18n";
import { approvalCookieName } from "../cookie";
import { refuseForeignRequest } from "../guard";

const EXPIRED = "This sign-in request expired. Start again from the app.";

export async function POST(request: Request): Promise<Response> {
  const foreign = refuseForeignRequest(request);
  if (foreign) return foreign;
  const { env } = getCloudflareContext() as unknown as { env: Env };
  let body: { requestId?: unknown; oauthReqInfo?: unknown; connectionLifetime?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", { status: 400, code: "invalid_json" });
  }
  const oauthReq = await readSignedRequest(body.oauthReqInfo, env);
  if (!oauthReq) return jsonError("Invalid or tampered OAuth state", { status: 400, code: "invalid_oauth_state" });
  if (!isApprovalId(body.requestId)) return jsonError(EXPIRED, { status: 400, code: "approval_expired" });
  // The deny list may have grown since the request was made.
  if (!(await requestKind(env, oauthReq))) {
    return jsonError("Kaption doesn't connect to this app.", { status: 403, code: "unauthorized_client" });
  }

  const jar = await cookies();
  const cookieName = approvalCookieName(body.requestId);
  const taken = await takeApproval(connectDeps(env), body.requestId, jar.get(cookieName)?.value, oauthReq);
  if (!taken.ok) {
    if (taken.error === "denied") {
      jar.delete(cookieName);
      return jsonError("This sign-in was declined in Kaption.", { status: 403, code: "approval_denied" });
    }
    if (taken.error === "not_approved") {
      return jsonError("Approve the sign-in in Kaption first.", { status: 409, code: "approval_pending" });
    }
    return jsonError(EXPIRED, { status: 400, code: taken.error === "mismatch" ? "approval_mismatch" : "approval_expired" });
  }
  jar.delete(cookieName);
  // mcp.ANY_CLIENT.16 — the proven phone must still be allowed (the owner may have switched it off meanwhile).
  if (!approvalAllowedForPhone(await loadRedirectPolicy(env.OAUTH_KV), taken.phone)) {
    return jsonError("Sign in with Kaption on this computer isn't available yet.", { status: 403, code: "approval_disabled" });
  }

  const accountRef = await deriveAccountRef(taken.phone, env.PHONE_REF_SECRET);
  if (!accountRef) return jsonError(EXPIRED, { status: 400, code: "approval_expired" });
  // mcp.ANY_CLIENT.19 — an unknown website's connection always ends after 90 days without use.
  const connectionLifetime = taken.record.kind === "unknown_web"
    ? DEFAULT_CONNECTION_LIFETIME
    : parseConnectionLifetime(body.connectionLifetime);
  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      // mcp.ANY_CLIENT.11 — where it returns to and how it was approved, readable without decrypting the grant.
      metadata: {
        label: `WhatsApp ${accountRef.slice(0, 13)}`,
        lifetime: connectionLifetime,
        destination: taken.record.destination,
        destinationDetail: taken.record.detail,
        via: "approval",
      },
      props: { accountRef, connectionLifetime },
      request: oauthReq,
      scope: oauthReq.scope,
      userId: accountRef,
    });
    await recordApprovalAudit(env.OAUTH_KV, accountRef, {
      at: Date.now(),
      outcome: "connected",
      appName: taken.record.appName,
      clientId: taken.record.clientId,
      destination: taken.record.destination,
      kind: taken.record.kind,
    });
    return Response.json({ redirectTo });
  } catch {
    // [H1] Never leak internal error details
    console.error(`[approval] OAuth completion failed for ${sanitizeAccountRefForLog(accountRef)}`);
    return jsonError("Authorization failed. Please try again.", { status: 500, code: "authorization_failed" });
  }
}
