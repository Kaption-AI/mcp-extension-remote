#!/usr/bin/env node
/**
 * mcp.ANOTHER_APP / ai-assistants.ADD.9 — "Add to Claude Desktop": builds public/downloads/kaption-whatsapp.mcpb, an MCP
 * Bundle (https://github.com/modelcontextprotocol/mcpb) of the local helper @kaptionai/mcp-extension, so Claude Desktop
 * installs it with one click (open the file → Install). Claude Desktop has no install deeplink; a bundle is its
 * supported method. The helper and its dependencies are bundled into one file (esbuild) and run with the Node that
 * Claude Desktop ships, so nothing needs npx on the person's PATH.
 *
 * Usage: node scripts/build-mcpb.mjs [version]   (default: the version pinned below). Run it by hand and commit the
 * result when the helper's version changes; the deploy does not run it.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED = "0.5.20";
const version = process.argv[2] || PINNED;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "downloads", "kaption-whatsapp.mcpb");
const work = mkdtempSync(join(tmpdir(), "kaption-mcpb-"));
const run = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

try {
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "kaption-mcpb-build", private: true }));
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", `@kaptionai/mcp-extension@${version}`]);
  const pkgDir = join(work, "node_modules", "@kaptionai", "mcp-extension");
  const bundle = join(work, "bundle");
  mkdirSync(join(bundle, "server"), { recursive: true });
  run("npx", ["-y", "esbuild@0.24.0", join(pkgDir, "dist", "index.js"), "--bundle", "--platform=node", "--target=node18",
    `--outfile=${join(bundle, "server", "index.js")}`, "--log-level=warning"]);
  // The helper reads its own version from ../package.json (its update check).
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  writeFileSync(join(bundle, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license }, null, 2));
  copyFileSync(join(root, "app", "icon.png"), join(bundle, "icon.png"));
  const manifest = {
    manifest_version: "0.3",
    name: "kaption-whatsapp",
    display_name: "Kaption for WhatsApp",
    version: pkg.version,
    description: "Your WhatsApp in your AI assistant, through Kaption on this computer.",
    long_description: "Connects to Kaption (the browser extension or the desktop app) on this computer. Kaption asks you to allow the connection the first time. Nothing goes through the cloud.",
    author: { name: "Kaption AI", url: "https://kaptionai.com" },
    homepage: "https://kaptionai.com",
    support: "https://kaptionai.com/support",
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: { command: "node", args: ["${__dirname}/server/index.js"] },
    },
    compatibility: { runtimes: { node: ">=18.0.0" } },
    license: pkg.license || "UNLICENSED",
  };
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  run("npx", ["-y", "@anthropic-ai/mcpb@2.1.2", "pack", bundle, out]);
  console.log(`built ${out} (helper ${pkg.version})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
