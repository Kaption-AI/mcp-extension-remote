#!/usr/bin/env node
/**
 * verify-chain.js — Cross-reference Cloudflare deployment versions against
 * the transparency chain to detect unsigned/unattested deploys.
 *
 * Expects two files in cwd:
 *   - cf_deployments.json  (from CF API /workers/scripts/mcp-remote/deployments)
 *   - chain.json           (from /transparency)
 *
 * Exit 0 if all CF versions are accounted for, exit 1 if gaps found.
 */

import { readFileSync } from "node:fs";

const cf = JSON.parse(readFileSync("cf_deployments.json", "utf8"));
const chain = JSON.parse(readFileSync("chain.json", "utf8"));

const cfDeployments = cf.result?.deployments ?? [];
const chainEntries = chain.entries ?? [];

// Build a set of CF version IDs recorded in the transparency chain
const attestedVersionIds = new Set(
  chainEntries
    .filter((e) => e.event?.cfVersionId)
    .map((e) => e.event.cfVersionId),
);

// Find CF versions with no chain entry
const gaps = cfDeployments.filter((d) => !attestedVersionIds.has(d.id));

// Report
console.log(`CF deployments:   ${cfDeployments.length}`);
console.log(`Chain entries:     ${chainEntries.length}`);
console.log(`Attested versions: ${attestedVersionIds.size}`);
console.log();

if (gaps.length === 0) {
  console.log("✓ All Cloudflare versions accounted for in transparency chain.");
  process.exit(0);
} else {
  // Entries without cfVersionId predate the post-deploy attestation feature.
  // Only flag CF versions created AFTER the first attested entry as gaps.
  const firstAttestedEntry = chainEntries.find((e) => e.event?.cfVersionId);
  const cutoffDate = firstAttestedEntry?.event?.deployedAt;

  const realGaps = cutoffDate
    ? gaps.filter((d) => d.created_on > cutoffDate)
    : gaps;

  if (realGaps.length === 0) {
    console.log(
      `✓ All Cloudflare versions accounted for. ${gaps.length} pre-attestation version(s) ignored.`,
    );
    process.exit(0);
  }

  console.error("✗ UNSIGNED DEPLOYMENTS DETECTED:\n");
  for (const gap of realGaps) {
    console.error(`  Version:    ${gap.id}`);
    console.error(`  Created:    ${gap.created_on}`);
    console.error(`  Source:     ${gap.source ?? "unknown"}`);
    console.error();
  }
  console.error(
    `${realGaps.length} Cloudflare version(s) have no Rekor attestation.`,
  );
  process.exit(1);
}
