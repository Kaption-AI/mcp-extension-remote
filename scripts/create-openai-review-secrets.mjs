#!/usr/bin/env node

import { chmod, writeFile } from "node:fs/promises";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Usage: create-openai-review-secrets.mjs <output-path>");
}

const names = [
  "OPENAI_APPS_CHALLENGE_TOKEN",
  "OPENAI_REVIEW_PHONE",
  "OPENAI_REVIEW_PASSWORD_SHA256",
];

const configured = Object.fromEntries(
  names
    .map((name) => [name, process.env[name] ?? ""])
    .filter(([, value]) => value.length > 0),
);

if (Object.keys(configured).length > 0 && Object.keys(configured).length !== names.length) {
  const missing = names.filter((name) => !(name in configured));
  throw new Error(
    `OpenAI review secrets must be configured atomically; missing: ${missing.join(", ")}`,
  );
}

if (Object.keys(configured).length === names.length) {
  if (!/^[1-9][0-9]{6,14}$/.test(configured.OPENAI_REVIEW_PHONE)) {
    throw new Error("OPENAI_REVIEW_PHONE must be an international digits-only phone number");
  }
  if (!/^[a-f0-9]{64}$/.test(configured.OPENAI_REVIEW_PASSWORD_SHA256)) {
    throw new Error("OPENAI_REVIEW_PASSWORD_SHA256 must be a lowercase SHA-256 hex digest");
  }
}

await writeFile(outputPath, JSON.stringify(configured), { mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(`Prepared ${Object.keys(configured).length} OpenAI review secret(s).`);
