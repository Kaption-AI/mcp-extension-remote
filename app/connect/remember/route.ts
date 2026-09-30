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
  redeemAllowed,
} from "@/src/connect-code";
import type { Env } from "@/src/types";
import { jsonError } from "@/app/i18n";

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Invalid content type", { status: 400 });
  }
  const { env } = getCloudflareContext() as unknown as { env: Env };
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await redeemAllowed(env.OAUTH_KV, ip))) {
    return jsonError("Too many tries. Wait a few minutes and try again.", { status: 429 });
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
    await countFailedRedeem(env.OAUTH_KV, ip);
    return jsonError("This code doesn't work any more. Get a new one in Kaption.", { status: 400 });
  }
  (await cookies()).set(CONNECT_COOKIE, code, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/authorize",
    maxAge: CONNECT_CODE_TTL_SECONDS,
  });
  return Response.json({ masked: maskPhone(phone) });
}
