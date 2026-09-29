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
  redeemAllowed,
  redeemConnectCode,
} from "@/src/connect-code";
import { deriveAccountRef, hmacVerify, sanitizeAccountRefForLog } from "@/src/otp";
import { parseConnectionLifetime } from "@/src/connection-lifetime-options";
import type { Env } from "@/src/types";

const EXPIRED = "This code doesn't work any more. Get a new one in Kaption → AI assistants, then paste it here.";

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return Response.json({ error: "Invalid content type" }, { status: 400 });
  }
  const { env } = getCloudflareContext() as unknown as { env: Env };
  let body: { code?: unknown; remembered?: unknown; oauthReqInfo?: unknown; connectionLifetime?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.oauthReqInfo !== "string" || !body.oauthReqInfo) {
    return Response.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await redeemAllowed(env.OAUTH_KV, ip))) {
    return Response.json({ error: "Too many tries. Wait a few minutes and try again." }, { status: 429 });
  }

  const jar = await cookies();
  const remembered = body.remembered === true;
  const input = remembered ? jar.get(CONNECT_COOKIE)?.value : body.code;
  if (!normalizeConnectCode(input)) {
    if (!remembered) await countFailedRedeem(env.OAUTH_KV, ip);
    return Response.json(
      { error: remembered ? EXPIRED : "That doesn't look like a Kaption code. It has 8 letters and numbers, like ABCD-2345.", forget: remembered },
      { status: 400 },
    );
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
    return Response.json({ error: "Invalid or tampered OAuth state" }, { status: 400 });
  }

  const phone = await redeemConnectCode(connectDeps(env), input);
  if (remembered) jar.delete(CONNECT_COOKIE);
  if (!phone) {
    await countFailedRedeem(env.OAUTH_KV, ip);
    return Response.json({ error: EXPIRED, forget: remembered }, { status: 400 });
  }
  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return Response.json({ error: EXPIRED }, { status: 400 });
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
    return Response.json({ redirectTo });
  } catch {
    // [H1] Never leak internal error details
    console.error(`[connect-code] OAuth completion failed for ${sanitizeAccountRefForLog(accountRef)}`);
    return Response.json({ error: "Authorization failed. Please try again." }, { status: 500 });
  }
}
