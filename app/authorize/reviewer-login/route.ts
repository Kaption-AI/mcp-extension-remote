/**
 * POST /authorize/reviewer-login — no-MFA access for OpenAI's review team.
 *
 * This path is disabled unless both OPENAI_REVIEW_* secrets are present.
 * It grants access only to a dedicated synthetic-data WhatsApp account whose
 * Kaption extension is connected to the normal production relay.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ReviewerLoginSchema } from "@/src/schemas";
import { deriveAccountRef, hmacVerify } from "@/src/otp";
import type { Env } from "@/src/types";
import { DEFAULT_CONNECTION_LIFETIME } from "@/src/connection-lifetime-options";
import { errorBody, jsonError } from "@/app/i18n";
import { withHeaders } from "@/src/problem";
import {
  rateLimitHeaders,
  readSlidingCounter,
  slidingStatus,
  tooManyRequests,
  writeSlidingCounter,
} from "@/src/rate-limit";

// Every attempt counts; the window restarts with each one, and a success clears it.
const REVIEWER_LOGIN_POLICY = { name: "reviewer-login-ip", limit: 10, windowSeconds: 15 * 60 };
const RATE_WINDOW_SECONDS = REVIEWER_LOGIN_POLICY.windowSeconds;
const MAX_ATTEMPTS = REVIEWER_LOGIN_POLICY.limit;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Invalid content type", { status: 400, code: "invalid_content_type" });
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };
  const passwordHash = env.OPENAI_REVIEW_PASSWORD_SHA256?.trim().toLowerCase();
  const phone = env.OPENAI_REVIEW_PHONE?.trim();
  if (!passwordHash || !phone || !/^[a-f0-9]{64}$/.test(passwordHash)) {
    return jsonError("Reviewer access is not configured", { status: 404, code: "reviewer_not_configured" });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("Invalid JSON body", { status: 400, code: "invalid_json" });
  }
  const parsed = await ReviewerLoginSchema.safeParseAsync(raw);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message || "Invalid input",
      { status: 400, code: "invalid_input" },
    );
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rateKey = `openai-review-login:${ip}`;
  const counter = await readSlidingCounter(env.OAUTH_KV, rateKey);
  const limit = slidingStatus(counter, REVIEWER_LOGIN_POLICY.name, MAX_ATTEMPTS, RATE_WINDOW_SECONDS);
  if (limit.remaining <= 0) {
    const message = "Too many attempts. Try again later.";
    return tooManyRequests(limit, message, { extra: errorBody(message) });
  }
  await writeSlidingCounter(env.OAUTH_KV, rateKey, counter.count + 1, RATE_WINDOW_SECONDS);
  const headers = rateLimitHeaders({ ...limit, remaining: limit.remaining - 1, resetSeconds: RATE_WINDOW_SECONDS });

  const submittedPhoneHash = await sha256Hex(parsed.data.phone);
  const configuredPhoneHash = await sha256Hex(phone.replace(/\D/g, ""));
  const submittedPasswordHash = await sha256Hex(parsed.data.password);
  if (
    !constantTimeEqual(submittedPhoneHash, configuredPhoneHash) ||
    !constantTimeEqual(submittedPasswordHash, passwordHash)
  ) {
    return jsonError("Invalid reviewer credentials", { status: 401, code: "invalid_credentials", headers });
  }

  const signedPayload = await hmacVerify(
    parsed.data.oauthReqInfo,
    env.INTERNAL_API_KEY,
  );
  if (!signedPayload) {
    return jsonError("Invalid or expired OAuth state", { status: 400, code: "invalid_oauth_state", headers });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = JSON.parse(atob(signedPayload)) as AuthRequest;
  } catch {
    return jsonError("Invalid OAuth state", { status: 400, code: "invalid_oauth_state", headers });
  }
  if (!oauthRequest.clientId) {
    return jsonError("Invalid OAuth state", { status: 400, code: "invalid_oauth_state", headers });
  }

  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return jsonError("Reviewer access is not configured", { status: 500, code: "reviewer_not_configured" });
  }

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      // mcp.CLOUD_RELAY.9 — no consent page in this path, so the default lifetime
      metadata: { label: "OpenAI plugin review", lifetime: DEFAULT_CONNECTION_LIFETIME },
      props: { accountRef, connectionLifetime: DEFAULT_CONNECTION_LIFETIME },
      request: oauthRequest,
      scope: oauthRequest.scope,
      userId: accountRef,
    });
    await env.OAUTH_KV.delete(rateKey);
    // A success clears this address's counter.
    return withHeaders(Response.json({ redirectTo }), rateLimitHeaders({ ...limit, remaining: MAX_ATTEMPTS, resetSeconds: RATE_WINDOW_SECONDS }));
  } catch {
    console.error("[reviewer-auth] OAuth completion failed");
    return jsonError("Authorization failed. Please try again.",
      { status: 500, code: "authorization_failed", headers },
    );
  }
}
