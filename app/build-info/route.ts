/**
 * GET /build-info — Return version, commit SHA, build hash.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Env } from "@/src/types";


export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext() as unknown as { env: Env };

  return Response.json({
    version: "1.0.0",
    commitSha: env.COMMIT_SHA || "unknown",
    buildHash: env.BUILD_HASH || "unknown",
    buildTimestamp: new Date().toISOString(),
    repo: "https://github.com/kaptionai/kaption-mcp-remote",
  });
}
