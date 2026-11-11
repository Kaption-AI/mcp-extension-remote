/**
 * mcp.ANY_CLIENT.18 — the approval routes answer only the sign-in page itself: a JSON body (its media type exactly
 * application/json, so "text/plain; x=application/json" — a cross-site simple request — is refused) and, when the
 * browser names one, the connector's own origin. The approval cookie is SameSite=Lax as well.
 */
import { jsonError } from "@/app/i18n";

export function refuseForeignRequest(request: Request): Response | null {
  const essence = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (essence !== "application/json") {
    return jsonError("Invalid content type", { status: 400, code: "invalid_content_type" });
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let ownOrigin: string | null = null;
    try {
      ownOrigin = new URL(request.url).origin;
    } catch {
      ownOrigin = null;
    }
    const host = request.headers.get("host");
    const sameAsHost = !!host && (origin === `https://${host}` || origin === `http://${host}`);
    if (origin !== ownOrigin && !sameAsHost) {
      return jsonError("Cross-origin request refused", { status: 403, code: "cross_origin" });
    }
  }
  return null;
}
