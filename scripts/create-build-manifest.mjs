#!/usr/bin/env node

/**
 * Build a deterministic content manifest for the complete OpenNext artifact.
 *
 * Hashing only `.open-next/worker.js` is insufficient because that file is a
 * small stable wrapper; the application code lives in its imported handlers.
 * This manifest covers every generated code, cache, and static-asset file.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] || ".open-next");
const output = resolve(process.argv[3] || join(root, "build-manifest.json"));

function normalized(path) {
  return path.split(sep).join("/");
}

function shouldExclude(path) {
  const rel = normalized(relative(root, path));
  return (
    rel === normalized(relative(root, output)) ||
    rel.endsWith(".sigstore.json") ||
    rel.endsWith("/.DS_Store") ||
    rel === ".DS_Store"
  );
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (shouldExclude(path)) continue;
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

const entries = walk(root)
  .sort((a, b) => normalized(relative(root, a)).localeCompare(normalized(relative(root, b))))
  .map((path) => {
    const stat = lstatSync(path);
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(`symlink:${readlinkSync(path)}`)
      : readFileSync(path);
    return {
      path: normalized(relative(root, path)),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });

const rootHasher = createHash("sha256");
for (const entry of entries) {
  rootHasher.update(entry.path);
  rootHasher.update("\0");
  rootHasher.update(String(entry.size));
  rootHasher.update("\0");
  rootHasher.update(entry.sha256);
  rootHasher.update("\n");
}
const buildHash = rootHasher.digest("hex");

writeFileSync(
  output,
  `${JSON.stringify({ schemaVersion: 1, buildHash, files: entries }, null, 2)}\n`,
);
process.stdout.write(`${buildHash}\n`);
