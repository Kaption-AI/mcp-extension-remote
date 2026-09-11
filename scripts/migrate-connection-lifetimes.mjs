#!/usr/bin/env node
/**
 * mcp.CLOUD_RELAY.11 — moves every connection made before connection
 * lifetimes to the default ("While I use it": it ends after 90 days without
 * use) and stops every app registration from expiring.
 *
 * The relay makes the same move on each connection's next refresh; this pass
 * covers the connections that are idle right now, whose old 30-day end could
 * otherwise come first. Their idle clock starts at the move, as on refresh.
 * Mirrors withDefaultLifetime() in src/connection-lifetime.ts.
 *
 * A connection refreshed in the last hour is in use, so it is left to the
 * relay: rewriting it here could race its refresh-token rotation. Every other
 * one is re-read right before the write and skipped if its refresh token
 * rotated in between.
 *
 *   node scripts/migrate-connection-lifetimes.mjs           # dry run
 *   node scripts/migrate-connection-lifetimes.mjs --apply   # write
 *
 * Needs `wrangler login` with KV write access. Safe to run again.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NAMESPACE_ID = "d8f86606c8e543079ebbdd7d72376a05"; // OAUTH_KV (wrangler.template.jsonc)
const DEFAULT_LIFETIME = "inactive-90d";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const apply = process.argv.includes("--apply");
const workDir = mkdtempSync(join(tmpdir(), "kaption-lifetimes-"));

function wrangler(...args) {
  return execFileSync(
    "npx",
    ["--no-install", "wrangler", "kv", ...args, "--namespace-id", NAMESPACE_ID, "--remote"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** wrangler prints the JSON and may follow it with a status line ("Success!"). */
function parseJson(output, open, close) {
  return JSON.parse(output.slice(output.indexOf(open), output.lastIndexOf(close) + 1));
}

const listKeys = (prefix) => parseJson(wrangler("key", "list", "--prefix", prefix), "[", "]");

function bulkGet(names) {
  const values = new Map();
  for (let start = 0; start < names.length; start += 100) {
    const file = join(workDir, `get-${start}.json`);
    writeFileSync(file, JSON.stringify(names.slice(start, start + 100)));
    for (const [name, entry] of Object.entries(parseJson(wrangler("bulk", "get", file), "{", "}"))) {
      const value = typeof entry === "string" ? entry : entry?.value;
      if (typeof value === "string") values.set(name, value);
    }
  }
  return values;
}

/** Entries carry no expiration, so the rewritten records stop expiring. */
function bulkPut(entries, label) {
  const file = join(workDir, `put-${label}.json`);
  writeFileSync(file, JSON.stringify(entries));
  wrangler("bulk", "put", file);
}

function withDefaultLifetime(grant, at) {
  const updated = {
    ...grant,
    metadata: { ...(grant.metadata ?? {}), lifetime: DEFAULT_LIFETIME, lifetimeSince: at },
  };
  delete updated.expiresAt;
  return updated;
}

const grantRef = (name) => name.split(":").slice(1, 3).join(":");
const now = Math.floor(Date.now() / 1000);

const grantKeys = listKeys("grant:");
const inUse = new Set(listKeys("token:").map((key) => grantRef(key.name)));
const grants = bulkGet(grantKeys.map((key) => key.name));
const candidates = [];
const counts = { chosen: 0, pending: 0, inUse: 0 };
for (const [name, value] of grants) {
  const grant = JSON.parse(value);
  if (grant.metadata?.lifetime) counts.chosen++;
  else if (!grant.refreshTokenId) counts.pending++; // consent given, code not exchanged yet
  else if (inUse.has(grantRef(name))) counts.inUse++;
  else candidates.push({ name, refreshTokenId: grant.refreshTokenId });
}
const expiringClients = listKeys("client:").filter((key) => key.expiration);

console.log(
  `connections: ${grantKeys.length} — ${counts.chosen} already have a lifetime, ${counts.pending} pending, ` +
    `${counts.inUse} in use (the relay moves them on refresh), ${candidates.length} to move`,
);
console.log(`app registrations that expire: ${expiringClients.length}`);
if (!apply) {
  console.log("Dry run. Pass --apply to write.");
  process.exit(0);
}

// Re-read right before writing; skip any connection whose token rotated meanwhile.
const fresh = bulkGet(candidates.map((candidate) => candidate.name));
const moves = [];
const originals = {};
for (const { name, refreshTokenId } of candidates) {
  const current = fresh.get(name);
  if (!current) continue; // revoked in the meantime
  const grant = JSON.parse(current);
  if (grant.refreshTokenId !== refreshTokenId || grant.metadata?.lifetime) continue;
  originals[name] = current;
  moves.push({ key: name, value: JSON.stringify(withDefaultLifetime(grant, now)) });
}
const clients = bulkGet(expiringClients.map((key) => key.name));
for (const [name, value] of clients) originals[name] = value;

const backup = join(workDir, "backup.json");
writeFileSync(backup, JSON.stringify(originals, null, 1));
if (moves.length) bulkPut(moves, "grants");
if (clients.size) bulkPut([...clients].map(([key, value]) => ({ key, value })), "clients");

console.log(`moved ${moves.length} connection(s) to ${DEFAULT_LIFETIME}`);
console.log(`app registrations no longer expiring: ${clients.size}`);
console.log(`records as they were before, for rollback: ${backup}`);
