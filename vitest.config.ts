import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // The OAuth library imports the Workers runtime; running it through Vite
    // lets the alias below stand in for that module in tests.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "cloudflare:workers": path.resolve(__dirname, "src/test-support/cloudflare-workers.ts"),
    },
  },
});
