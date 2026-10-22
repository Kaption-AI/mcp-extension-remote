/**
 * POST /ext-auth/revoke — Revoke an extension session token.
 *
 * Security: [H5] Session revocation endpoint.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { RevokeSessionSchema } from "@/src/schemas";
import { revokeExtensionSession } from "@/src/otp";
import type { Env } from "@/src/types";
import { corsOptions, withCors } from "../cors";
import { problem } from "@/src/problem";

// The extension reads only the status; `error` stays for older callers.
function invalid(code: string, message: string): Response {
  return problem({ status: 400, code, detail: message, extra: { error: message } });
}

export async function OPTIONS(request: Request): Promise<Response> {
  return corsOptions(request);
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return withCors(invalid("invalid_content_type", "Invalid content type"), request);
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return withCors(invalid("invalid_json", "Invalid JSON body"), request);
  }

  const parsed = RevokeSessionSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return withCors(invalid("invalid_input", msg), request);
  }

  await revokeExtensionSession(env.OAUTH_KV, parsed.data.token);
  return withCors(Response.json({ ok: true }), request);
}
