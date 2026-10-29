// Tool descriptions are read by Claude and ChatGPT, who repeat them to the person: no internal
// feature-flag names, engine names or "owner-only" wording.
import { describe, it, expect } from "vitest";
import { getToolsForMCP } from "./tools";

describe("tool descriptions use plain words", () => {
  it("name no internal flag or engine", () => {
    const text = JSON.stringify(getToolsForMCP());
    expect(text).not.toMatch(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/);
    expect(text).not.toMatch(/owner-only|Rust core|Rust extension/i);
  });
});
