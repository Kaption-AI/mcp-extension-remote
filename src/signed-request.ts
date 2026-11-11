/**
 * The OAuth request a sign-in page carries ([M3]: HMAC-signed by /authorize, so a page can't change it), and what
 * kind of app it sends the code to under the owner's policy (mcp.ANY_CLIENT.1-3).
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hmacVerify } from "./otp";
import { approvalOnly, classifyWithPolicy, loadRedirectPolicy, type PolicyRedirectKind } from "./redirect-policy";
import type { Env } from "./types";

export async function readSignedRequest(oauthReqInfo: unknown, env: Pick<Env, "INTERNAL_API_KEY">): Promise<AuthRequest | null> {
  if (typeof oauthReqInfo !== "string" || !oauthReqInfo) return null;
  const raw = await hmacVerify(oauthReqInfo, env.INTERNAL_API_KEY);
  if (!raw) return null;
  try {
    const request = JSON.parse(atob(raw)) as AuthRequest;
    return request?.clientId ? request : null;
  } catch {
    return null;
  }
}

/** The redirect's kind now (the deny list may have changed since /authorize), or null when it is refused. */
export async function requestKind(env: Pick<Env, "OAUTH_KV">, request: Pick<AuthRequest, "redirectUri">): Promise<PolicyRedirectKind | null> {
  return classifyWithPolicy(request.redirectUri, await loadRedirectPolicy(env.OAUTH_KV));
}

/**
 * mcp.ANY_CLIENT.3 — the phone + WhatsApp code, the Kaption code and the reviewer sign-in refuse a request that only the
 * approval on the person's computer may complete (an unknown website), and one the deny list now refuses.
 */
export async function refusesDirectSignIn(env: Pick<Env, "OAUTH_KV">, request: Pick<AuthRequest, "redirectUri">): Promise<boolean> {
  const kind = await requestKind(env, request);
  return kind === null || approvalOnly(kind);
}

export const APPROVAL_REQUIRED_MESSAGE =
  "This app can only be approved from Kaption on your computer. Choose Sign in with Kaption on this computer.";
