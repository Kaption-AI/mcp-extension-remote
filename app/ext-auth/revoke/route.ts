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

export async function OPTIONS(): Promise<Response> {
  return corsOptions();
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return withCors(Response.json({ error: "Invalid content type" }, { status: 400 }));
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return withCors(Response.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  const parsed = RevokeSessionSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return withCors(Response.json({ error: msg }, { status: 400 }));
  }

  await revokeExtensionSession(env.EXT_AUTH_KV, parsed.data.token);
  return withCors(Response.json({ ok: true }));
}
