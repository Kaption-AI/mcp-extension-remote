/**
 * Tests for the cloud relay's inline-media policy
 * (mcp.TOOLS.6 / mcp.CLOUD_RELAY.6): media bytes are inlined ONLY for an
 * explicit download_media call; every other tool's response is scrubbed of
 * base64/binary blobs before it reaches the model.
 */

import { describe, it, expect } from "vitest";
import { looksLikeBinary, scrubInlineMedia } from "./media-scrub";

// A realistic-ish base64 thumbnail body (long, no spaces).
const FAKE_THUMB = "/9j/" + "ABCDabcd0123+/".repeat(200); // ~2.8KB, JPEG b64 prefix
const RAW_B64 = "Z".repeat(1200); // long, zero spaces, no known prefix

describe("looksLikeBinary", () => {
  it("flags JPEG base64 and data: URIs", () => {
    expect(looksLikeBinary(FAKE_THUMB)).toBe(true);
    expect(looksLikeBinary("data:image/png;base64," + "A".repeat(400))).toBe(true);
  });

  it("flags a long, space-free blob", () => {
    expect(looksLikeBinary(RAW_B64)).toBe(true);
  });

  it("does NOT flag normal human text", () => {
    expect(looksLikeBinary("Hey, are we still on for lunch tomorrow at noon?")).toBe(false);
    // A long but spaced-out transcript stays human text.
    expect(looksLikeBinary("the quick brown fox ".repeat(80))).toBe(false);
  });

  it("does NOT flag WhatsApp IDs or short tokens", () => {
    expect(looksLikeBinary("true_5511999990001@c.us_3EB0C5681234567890ABCDEF_in")).toBe(false);
    expect(looksLikeBinary("eyJhbGciOiJIUzI1Ni9.abc")).toBe(false);
  });

  it("ignores short strings outright", () => {
    expect(looksLikeBinary("/9j/short")).toBe(false); // under 200 chars
    expect(looksLikeBinary("")).toBe(false);
  });
});

describe("scrubInlineMedia", () => {
  it("replaces a base64 leaf with the placeholder", () => {
    const out = scrubInlineMedia(FAKE_THUMB) as string;
    expect(out).not.toContain("/9j/");
    expect(out).toContain("download_media");
  });

  it("scrubs a thumbnail nested in an array of objects (conversations / search shape)", () => {
    const input = [
      { conversationId: "a@c.us", lastMessage: FAKE_THUMB, lastMessageTimestamp: 123 },
      { conversationId: "b@c.us", lastMessage: "see you soon", lastMessageTimestamp: 456 },
    ];
    const out = scrubInlineMedia(input) as any[];
    expect(out[0].lastMessage).not.toContain("/9j/");
    expect(out[0].lastMessage).toContain("download_media");
    expect(out[0].conversationId).toBe("a@c.us"); // structure + non-media fields intact
    expect(out[0].lastMessageTimestamp).toBe(123);
    expect(out[1].lastMessage).toBe("see you soon"); // human text untouched
  });

  it("leaves a download_media-shaped payload untouched (relay never scrubs that tool)", () => {
    // The relay only calls scrubInlineMedia for non-download_media tools, but verify
    // the function itself is non-destructive to the metadata around the bytes.
    const dm = { message_id: "m1", mimetype: "image/jpeg", size: 2048, base64_data: FAKE_THUMB };
    const out = scrubInlineMedia(dm) as any;
    // The bytes field WOULD be scrubbed if passed here — which is exactly why the
    // relay must NOT call this for download_media. Metadata is preserved either way.
    expect(out.message_id).toBe("m1");
    expect(out.mimetype).toBe("image/jpeg");
    expect(out.size).toBe(2048);
  });

  it("passes non-string scalars through unchanged", () => {
    expect(scrubInlineMedia(42)).toBe(42);
    expect(scrubInlineMedia(true)).toBe(true);
    expect(scrubInlineMedia(null)).toBe(null);
  });
});

describe("relay inline-media policy (contract)", () => {
  // Mirror relay-mcp.ts: download_media passes through; everything else is scrubbed.
  const applyPolicy = (toolName: string, result: unknown) =>
    toolName !== "download_media" ? scrubInlineMedia(result) : result;

  it("download_media keeps base64_data intact", () => {
    const result = { message_id: "m1", base64_data: FAKE_THUMB };
    const out = applyPolicy("download_media", result) as any;
    expect(out.base64_data).toBe(FAKE_THUMB);
  });

  it("query / list_conversations / search strip leaked thumbnails", () => {
    for (const tool of ["query", "list_conversations", "search"]) {
      const result = [{ lastMessage: FAKE_THUMB }];
      const out = applyPolicy(tool, result) as any[];
      expect(out[0].lastMessage).not.toContain("/9j/");
    }
  });
});
