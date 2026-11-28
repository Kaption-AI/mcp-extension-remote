/**
 * mcp-usage-pricing.USAGE.1-8 (Kaption-AI monorepo spec) — the pure usage rules shared with the monorepo. The relay's
 * counting and refusing moved to the account's ledger (mcp-usage-ledger.SINGLE): see single-counter.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ledgerUsage, normalizeUsage, refusalFallback, usageHeaders, usageLang, usageLine, usageMeta, withUsageHeaders, type Usage } from "./weekly-usage";
import fixture from "./test-support/weekly-plan-limits-usage.json";

const WEEK: Usage = { period: "week", used: 17, limit: 20, left: 3, resetsAt: "2026-11-16T00:00:00.000Z", source: "ledger", overage: null };

describe("mcp-usage-ledger.SINGLE.4 the ledger's usage and refusal words", () => {
  it("mcp-usage-pricing.USAGE.1, mcp-usage-ledger.SINGLE.2 — usage from the plan's window; null without a plan", () => {
    const plan = { tier: "free", period: "week", limit: 20, pool: null, enforcedBy: "ledger", ttlSeconds: 60, enforce: true, message: null, lang: null } as const;
    expect(ledgerUsage(plan, { counted: 17, to: "2026-11-16T00:00:00.000Z" })).toEqual(WEEK);
    expect(ledgerUsage({ ...plan, limit: null, period: null }, { counted: 3, to: "x" })).toMatchObject({ limit: null, left: null });
    expect(ledgerUsage(null, { counted: 3, to: "x" })).toBeNull();
    // weekly-plan-limits.CREDITS_V2.7 — an answer without period or unit still says credits (a month).
    expect(refusalFallback(20)).toContain("this month's 20 Claude and ChatGPT credits");
  });
});

describe("mcp-usage-pricing.USAGE.1, USAGE.6-7 the pure rules", () => {
  it("mcp-usage-pricing.USAGE_IN_RESULTS.1-3 replays the shared fixture's usage section (normalizeUsage, usageMeta, usageLang, usageLine)", () => {
    expect(fixture.usage.length).toBeGreaterThan(100);
    for (const c of fixture.usage as any[]) {
      expect(normalizeUsage(c.value)).toEqual(c.normalized);
      expect(usageMeta(c.value)).toEqual(c.meta);
      expect(usageLang(c.lang)).toBe(c.langUsed);
      expect(usageLine(c.value, c.lang)).toBe(c.result);
    }
  });

  it("mcp-usage-pricing.USAGE.6 headers, a header omitted when its value is null", () => {
    expect(usageHeaders(WEEK)).toEqual({
      "X-Kaption-Usage-Period": "week", "X-Kaption-Usage-Used": "17", "X-Kaption-Usage-Limit": "20", "X-Kaption-Usage-Left": "3",
      "X-Kaption-Usage-Resets": "2026-11-16T00:00:00.000Z",
    });
    expect(usageHeaders({ ...WEEK, limit: null, left: null, overage: { enabled: true, spent: 35, cap: 1000, balance: 900 } })).toEqual({
      "X-Kaption-Usage-Period": "week", "X-Kaption-Usage-Used": "17", "X-Kaption-Usage-Resets": "2026-11-16T00:00:00.000Z",
      "X-Kaption-Overage-Spent": "35", "X-Kaption-Overage-Cap": "1000", "X-Kaption-Overage-Balance": "900",
    });
  });

  it("mcp-usage-pricing.USAGE.6, USAGE.8 the response headers on a JSON /mcp result; untouched when off, SSE or without usage", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const rpc = { jsonrpc: "2.0", id: 1, result: { content: [], _meta: { kaption: { usage: WEEK } } } };
    const on = await withUsageHeaders(json(rpc), { MCP_USAGE_IN_RESULTS: "on" });
    expect(on.headers.get("X-Kaption-Usage-Left")).toBe("3");
    expect(await on.json()).toEqual(rpc);
    const off = json(rpc);
    expect(await withUsageHeaders(off, {})).toBe(off);
    const sse = new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    expect(await withUsageHeaders(sse, { MCP_USAGE_IN_RESULTS: "on" })).toBe(sse);
    expect((await withUsageHeaders(json({ result: {} }), { MCP_USAGE_IN_RESULTS: "on" })).headers.get("X-Kaption-Usage-Left")).toBeNull();
  });
});
