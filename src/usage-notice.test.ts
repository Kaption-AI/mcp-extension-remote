import { describe, expect, it } from "vitest";
import { takeUsageNotice } from "./usage-notice";

describe("mcp-usage-pricing.RELAY.1 — usage notice line", () => {
  it("moves _kaption_notice out of the result", () => {
    const out = takeUsageNotice({ messages: [1], _kaption_notice: " Kaption note for the user: 80% used. " });
    expect(out).toEqual({ result: { messages: [1] }, notice: "Kaption note for the user: 80% used." });
  });
  it("leaves results without the field untouched (same object)", () => {
    const result = { messages: [1] };
    expect(takeUsageNotice(result).result).toBe(result);
    expect(takeUsageNotice(result).notice).toBeNull();
    expect(takeUsageNotice("text").notice).toBeNull();
    expect(takeUsageNotice([1, 2]).notice).toBeNull();
    expect(takeUsageNotice(null).notice).toBeNull();
  });
  it("drops an empty or non-string notice and caps its length", () => {
    expect(takeUsageNotice({ a: 1, _kaption_notice: 5 })).toEqual({ result: { a: 1 }, notice: null });
    expect(takeUsageNotice({ _kaption_notice: "x".repeat(5000) }).notice).toHaveLength(1000);
  });
});
