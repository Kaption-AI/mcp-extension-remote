#!/usr/bin/env node
/**
 * build-config.mjs — Generate `wrangler.jsonc` from `wrangler.template.jsonc`
 * by substituting `__BUILD_HASH__` and `__COMMIT_SHA__` placeholders.
 *
 * Modes:
 *   - In CI ($CI=true): Reads COMMIT_SHA from $GITHUB_SHA or `git rev-parse HEAD`.
 *     If .open-next/worker.js exists, computes the SHA-256 BUILD_HASH from it;
 *     otherwise leaves BUILD_HASH=`pending-build` (CI re-runs this script after
 *     `build:worker` to finalize it). Writes a deploy-ready `wrangler.jsonc`.
 *
 *   - Local dev ($KAPTIONAI_LOCAL_DEV=1): Writes `wrangler.jsonc` with
 *     placeholder values intact (`local-dev` markers). Sufficient for
 *     `wrangler dev`; will NOT produce a valid signed deploy.
 *
 *   - Otherwise: BAILS WITH ERROR. This is the guard rail that makes
 *     `npx wrangler deploy` from a developer machine impossible — there's
 *     no `wrangler.jsonc` for wrangler to find, so the deploy aborts.
 *
 * All deploys MUST go through `.github/workflows/deploy.yml`. The pipeline
 * Sigstore-signs the bundle, records it in Rekor, and appends a hash-linked
 * entry to the public transparency chain at https://mcp-ext.kaptionai.com/transparency.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const TEMPLATE = "wrangler.template.jsonc";
const OUTPUT = "wrangler.jsonc";
const WORKER_BUNDLE = ".open-next/worker.js";

const isCI = process.env.CI === "true";
const isLocalDev = process.env.KAPTIONAI_LOCAL_DEV === "1";

if (!isCI && !isLocalDev) {
  console.error(
    "\nDeploy guard tripped.\n" +
      "  `wrangler.jsonc` is not present and `scripts/build-config.mjs` refuses to\n" +
      "  generate it outside CI. All production deploys MUST go through GitHub\n" +
      "  Actions (.github/workflows/deploy.yml) so the bundle is Sigstore-signed\n" +
      "  and appended to the deployment transparency chain.\n\n" +
      "  If you are running `wrangler dev` locally, use:\n" +
      "      npm run dev\n" +
      "  (it sets KAPTIONAI_LOCAL_DEV=1 and writes a dev-only wrangler.jsonc).\n",
  );
  process.exit(1);
}

if (!existsSync(TEMPLATE)) {
  console.error(`Error: ${TEMPLATE} not found.`);
  process.exit(1);
}

let buildHash;
let commitSha;

if (isCI) {
  // Two-pass: pre-build pass has no worker.js yet, post-build pass does.
  if (existsSync(WORKER_BUNDLE)) {
    buildHash = createHash("sha256")
      .update(readFileSync(WORKER_BUNDLE))
      .digest("hex");
  } else {
    buildHash = "pending-build";
  }
  commitSha =
    process.env.GITHUB_SHA ??
    execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
} else {
  buildHash = "local-dev";
  commitSha = "local-dev";
}

const template = readFileSync(TEMPLATE, "utf8");
const rendered = template
  .replace(/__BUILD_HASH__/g, buildHash)
  .replace(/__COMMIT_SHA__/g, commitSha);

if (rendered === template) {
  console.error(
    `Error: template has no __BUILD_HASH__ / __COMMIT_SHA__ placeholders to substitute.`,
  );
  process.exit(1);
}

writeFileSync(OUTPUT, rendered);
console.log(
  `Wrote ${OUTPUT} (BUILD_HASH=${buildHash.slice(0, 12)}…, COMMIT_SHA=${commitSha.slice(0, 7)})`,
);
