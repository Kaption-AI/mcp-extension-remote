/**
 * POST /register — Dynamic OAuth client registration (hardened).
 *
 * Security: [H4] Restrict redirect_uris to known patterns.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { RegisterClientSchema, isAllowedRedirectUri } from "@/src/schemas";
import type { Env } from "@/src/types";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return Response.json({ error: "Invalid content type" }, { status: 400 });
  }

  const { env } = getCloudflareContext() as unknown as { env: Env };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = RegisterClientSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return Response.json({ error: msg }, { status: 400 });
  }

  const { client_id, client_name, redirect_uris } = parsed.data;

  // [H4] Validate all redirect URIs against allowlist
  const invalidUris = redirect_uris.filter((uri) => !isAllowedRedirectUri(uri));
  if (invalidUris.length > 0) {
    return Response.json(
      {
        error: "Invalid redirect_uris. Only known MCP client domains are allowed.",
      },
      { status: 400 },
    );
  }

  try {
    await env.OAUTH_PROVIDER.createClient({
      clientId: client_id,
      clientName: client_name || "MCP Client",
      redirectUris: redirect_uris,
    });

    return Response.json({
      client_id,
      client_name: client_name || "MCP Client",
      redirect_uris,
      scopes: ["whatsapp"],
    });
  } catch {
    // [H1] Never leak internal error details
    return Response.json(
      { error: "Client registration failed" },
      { status: 500 },
    );
  }
}
