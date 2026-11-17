/**
 * mcp-local-hub-growth.CLIENT.4-5 — the MCP client is cut down and normalized exactly as the extension (TypeScript) and
 * the Rust core do it.
 *
 * src/test-support/mcp-clients.json is a copy of kaptionai kaption-core/fixtures/mcp/clients.json — the kaptionai copy
 * is the source of truth; refresh this one from it when it changes.
 */
import { describe, expect, it } from "vitest";
import fixture from "./test-support/mcp-clients.json";
import { normalizeMcpClient, sanitizeClientInfo, sanitizeClientName, sanitizeClientVersion } from "./client";

type Case = { name: string | null; version: string | null; path: "local" | "cloud"; expected: Record<string, string> };

describe("mcp-local-hub-growth.CLIENT.4 the pinned fixture", () => {
  it("mcp-local-hub-growth.CLIENT.4 — the fixture holds cases for both paths", () => {
    expect((fixture.cases as Case[]).length).toBeGreaterThan(20);
  });
  for (const c of fixture.cases as Case[]) {
    it(`mcp-local-hub-growth.CLIENT.4 — ${JSON.stringify(c.name)} ${JSON.stringify(c.version)} on ${c.path} -> ${c.expected.mcpClient}`, () => {
      expect(normalizeMcpClient(c.name, c.version, c.path)).toEqual(c.expected);
    });
  }
});

describe("mcp-local-hub-growth.CLIENT.5 sanitization", () => {
  it("mcp-local-hub-growth.CLIENT.5 — name: whitespace collapsed, only letters, digits, space and . _ - / ( ) +, 32 chars, trimmed", () => {
    expect(sanitizeClientName("  Claude\t\n Desktop  ")).toBe("Claude Desktop");
    expect(sanitizeClientName("a@b <c> d")).toBe("ab c d");
    expect(sanitizeClientName("x  @  y")).toBe("x y");
    expect(sanitizeClientName("ok._-/()+")).toBe("ok._-/()+");
    expect(sanitizeClientName("é ü ñ 名前")).toBe("");
    expect(sanitizeClientName("a".repeat(31) + " b")).toBe("a".repeat(31));
    expect(sanitizeClientName("x".repeat(40))).toHaveLength(32);
    expect(sanitizeClientName(null)).toBe("");
    expect(sanitizeClientName(42)).toBe("");
  });

  it("mcp-local-hub-growth.CLIENT.5 — version: only letters, digits and . + -, 16 chars", () => {
    expect(sanitizeClientVersion("1.2.3-beta+build_7 ")).toBe("1.2.3-beta+build");
    expect(sanitizeClientVersion("v 1/2")).toBe("v12");
    expect(sanitizeClientVersion(undefined)).toBe("");
  });

  it("mcp-local-hub-growth.CLIENT.5 — clientInfo keeps only name and version; no name is no client", () => {
    expect(sanitizeClientInfo({ name: " Cursor ", version: "1.7", title: "x", extra: { phone: "1" } })).toEqual({ name: "Cursor", version: "1.7" });
    expect(sanitizeClientInfo({ name: "@@", version: "1" })).toBeNull();
    expect(sanitizeClientInfo(null)).toBeNull();
  });
});
