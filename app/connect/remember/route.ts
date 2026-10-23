/**
 * POST /connect/remember — mcp.CONNECT_CODE.4: the /connect page hands over the code from its URL fragment (never
 * sent to a server by the browser on its own), and this browser remembers it for Kaption's sign-in page: an HttpOnly
 * cookie for this site only, as long as the code lasts. Answers the masked phone.
 */
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  CONNECT_CODE_TTL_SECONDS,
  CONNECT_COOKIE,
  connectDeps,
  countFailedRedeem,
  maskPhone,
  normalizeConnectCode,
  peekConnectCode,
  redeemLimit,
} from "@/src/connect-code";
import type { Env } from "@/src/types";
import { errorBody, jsonError } from "@/app/i18n";
import { withHeaders } from "@/src/problem";
import { rateLimitHeaders, tooManyRequests } from "@/src/rate-limit";

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Invalid content type", { status: 400, code: "invalid_content_type" });
  }
  const { env } = getCloudflareContext() as unknown as { env: Env };
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  // Only wrong codes count against this limit.
  const limit = await redeemLimit(env.OAUTH_KV, ip);
  if (limit.remaining <= 0) {
    const message = "Too many tries. Wait a few minutes and try again.";
    return tooManyRequests(limit, message, { extra: errorBody(message) });
  }
  let body: { code?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const code = normalizeConnectCode(body.code);
  const phone = code ? await peekConnectCode(connectDeps(env), code) : null;
  if (!code || !phone) {
    const after = await countFailedRedeem(env.OAUTH_KV, ip);
    return jsonError("This code doesn't work any more. Get a new one in Kaption.", {
      status: 400,
      code: "connect_code_expired",
      headers: rateLimitHeaders(after),
    });
  }
  (await cookies()).set(CONNECT_COOKIE, code, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/authorize",
    maxAge: CONNECT_CODE_TTL_SECONDS,
  });
  return withHeaders(Response.json({ masked: maskPhone(phone) }), rateLimitHeaders(limit));
}
