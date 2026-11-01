import { describe, expect, it } from "vitest";
import { getToolsForMCP } from "./tools";

// Claude's Connectors Directory and Google Connected Apps both reject tools
// without a title or a readOnlyHint/destructiveHint annotation.
describe("tool metadata for directory review", () => {
  it("gives every tool a title and both safety hints", () => {
    for (const tool of getToolsForMCP()) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
    }
  });
});

// The ChatGPT app submission lists every public tool with the same safety hints the server advertises.
describe("chatgpt-app-submission.json", () => {
  it("matches the public tool list and its hints", async () => {
    const { readFileSync } = await import("node:fs");
    const { CLOUD_TOOLS } = await import("./tools");
    const submission = JSON.parse(readFileSync(new URL("../chatgpt-app-submission.json", import.meta.url), "utf8"));
    expect(Object.keys(submission.tools).sort()).toEqual(CLOUD_TOOLS.map((t) => t.name).sort());
    for (const tool of CLOUD_TOOLS) {
      const listed = submission.tools[tool.name].annotations;
      expect(listed.readOnlyHint, tool.name).toBe(tool.annotations?.readOnlyHint);
      expect(listed.destructiveHint, tool.name).toBe(tool.annotations?.destructiveHint);
      expect(listed.openWorldHint, tool.name).toBe(tool.annotations?.openWorldHint);
    }
  });
});
