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

const RATE_WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 10;

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
    return Response.json({ error: "Invalid content type" }, { status: 400 });
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };
  const passwordHash = env.OPENAI_REVIEW_PASSWORD_SHA256?.trim().toLowerCase();
  const phone = env.OPENAI_REVIEW_PHONE?.trim();
  if (!passwordHash || !phone || !/^[a-f0-9]{64}$/.test(passwordHash)) {
    return Response.json({ error: "Reviewer access is not configured" }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = await ReviewerLoginSchema.safeParseAsync(raw);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message || "Invalid input" },
      { status: 400 },
    );
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rateKey = `openai-review-login:${ip}`;
  const attempts = Number(await env.OAUTH_KV.get(rateKey)) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    return Response.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(RATE_WINDOW_SECONDS) } },
    );
  }
  await env.OAUTH_KV.put(rateKey, String(attempts + 1), {
    expirationTtl: RATE_WINDOW_SECONDS,
  });

  const submittedPhoneHash = await sha256Hex(parsed.data.phone);
  const configuredPhoneHash = await sha256Hex(phone.replace(/\D/g, ""));
  const submittedPasswordHash = await sha256Hex(parsed.data.password);
  if (
    !constantTimeEqual(submittedPhoneHash, configuredPhoneHash) ||
    !constantTimeEqual(submittedPasswordHash, passwordHash)
  ) {
    return Response.json({ error: "Invalid reviewer credentials" }, { status: 401 });
  }

  const signedPayload = await hmacVerify(
    parsed.data.oauthReqInfo,
    env.INTERNAL_API_KEY,
  );
  if (!signedPayload) {
    return Response.json({ error: "Invalid or expired OAuth state" }, { status: 400 });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = JSON.parse(atob(signedPayload)) as AuthRequest;
  } catch {
    return Response.json({ error: "Invalid OAuth state" }, { status: 400 });
  }
  if (!oauthRequest.clientId) {
    return Response.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  const accountRef = await deriveAccountRef(phone, env.PHONE_REF_SECRET);
  if (!accountRef) {
    return Response.json({ error: "Reviewer access is not configured" }, { status: 500 });
  }

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      metadata: { label: "OpenAI plugin review" },
      props: { accountRef },
      request: oauthRequest,
      scope: oauthRequest.scope,
      userId: accountRef,
    });
    await env.OAUTH_KV.delete(rateKey);
    return Response.json({ redirectTo });
  } catch {
    console.error("[reviewer-auth] OAuth completion failed");
    return Response.json(
      { error: "Authorization failed. Please try again." },
      { status: 500 },
    );
  }
}
