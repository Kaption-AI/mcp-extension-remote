/**
 * Media-scrub — enforces the cloud relay's inline-media policy.
 *
 * mcp.TOOLS.7 — media bytes are inlined ONLY for an explicit `download_media` call;
 * no other tool inlines media. Every other tool must not leak base64/binary blobs
 * (e.g. thumbnail bodies surfaced via `conversations.lastMessage` or `search.text`)
 * into the model's context window. `download_media` responses pass through untouched
 * (mcp.TOOLS.6 / mcp.CLOUD_RELAY.6).
 */

const MEDIA_PLACEHOLDER = "[media omitted — call download_media to retrieve the bytes]";

/**
 * Detect a base64/binary blob rather than human text.
 * Ported verbatim from the extension's proven detector
 * (kaptionai/kext/src/core/mcp/handlers/query.ts `looksLikeBinary`). The
 * conservative thresholds make false positives on real text — transcripts,
 * WhatsApp IDs, summaries — effectively impossible.
 */
export function looksLikeBinary(text: string): boolean {
  if (!text || text.length < 200) return false;
  // base64 data URIs or raw base64 (JPEG magic prefix / data: URI)
  if (text.startsWith("/9j/") || text.startsWith("data:")) return true;
  // very long string with almost no spaces ⇒ binary, not prose
  const spaceRatio = (text.match(/ /g) || []).length / text.length;
  return text.length > 500 && spaceRatio < 0.02;
}

/**
 * Recursively replace inline base64/binary string leaves with a placeholder.
 * Non-mutating: returns a new value, leaving the input untouched. Safe to call
 * on arbitrary tool results — non-string, non-media values pass through as-is.
 */
export function scrubInlineMedia(value: unknown): unknown {
  if (typeof value === "string") {
    return looksLikeBinary(value) ? MEDIA_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubInlineMedia(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubInlineMedia(v);
    }
    return out;
  }
  return value;
}
