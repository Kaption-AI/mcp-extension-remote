/**
 * GET /authorize/approval/try — mcp.ANY_CLIENT.16: while the owner's switch is "allowlist", this browser opts in to
 * see "Sign in with Kaption on this computer" (30 days); `?off=1` opts out. The cookie is not a credential: an
 * approval still completes only for a phone on the allowlist, proven by the WhatsApp handshake.
 */
import { TESTER_COOKIE } from "@/src/redirect-policy";

const THIRTY_DAYS = 30 * 24 * 3600;

export async function GET(request: Request): Promise<Response> {
  const off = new URL(request.url).searchParams.get("off") === "1";
  const cookie = off
    ? `${TESTER_COOKIE}=; Path=/authorize; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
    : `${TESTER_COOKIE}=1; Path=/authorize; Max-Age=${THIRTY_DAYS}; HttpOnly; Secure; SameSite=Lax`;
  const text = off
    ? "This browser no longer tries the new Kaption sign-in."
    : "This browser now tries the new Kaption sign-in (Sign in with Kaption on this computer) for 30 days, for allowed phones only.";
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": cookie },
  });
}
