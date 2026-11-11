/**
 * POST /authorize/approval/status — mcp.ANY_CLIENT.12: the sign-in page's poll while Kaption asks in WhatsApp.
 * Only the browser that started the request (its cookie) learns anything; any other answer is "expired".
 */
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { approvalStatusForBrowser, isApprovalId } from "@/src/approval";
import { connectDeps } from "@/src/connect-code";
import type { Env } from "@/src/types";
import { jsonError } from "@/app/i18n";
import { approvalCookieName } from "../cookie";

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Invalid content type", { status: 400, code: "invalid_content_type" });
  }
  const { env } = getCloudflareContext() as unknown as { env: Env };
  let body: { requestId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (!isApprovalId(body.requestId)) return Response.json({ status: "expired" });
  const secret = (await cookies()).get(approvalCookieName(body.requestId))?.value;
  const status = await approvalStatusForBrowser(connectDeps(env), body.requestId, secret);
  return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
}
