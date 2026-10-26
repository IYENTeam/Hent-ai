#!/usr/bin/env node
// Enforces the session-brain topology (docs/adr/ADR-0002-session-brain-bridge.md):
// the service holds no Discord code or messenger token, and the session kit has no runtime dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const serviceFiles = [
  ...walk(resolve(root, "service/src")),
  ...walk(resolve(root, "service/scripts")),
  ...walk(resolve(root, "service/deploy")),
  resolve(root, "service/package.json"),
].filter((path) => existsSync(path));
const forbiddenServiceTokens = ["discord.com", "api/v10", "HENT_AI_DISCORD"];
for (const path of serviceFiles) {
  const text = readFileSync(path, "utf-8");
  for (const token of forbiddenServiceTokens) {
    if (text.includes(token)) failures.push(`${relative(root, path)} must not contain Discord/messenger token surface: ${token}`);
  }
}

const kitPackagePath = resolve(root, "kit/cli/package.json");
if (!existsSync(kitPackagePath)) {
  failures.push("kit/cli/package.json is missing");
} else {
  const kitPackage = JSON.parse(readFileSync(kitPackagePath, "utf-8"));
  if (Object.keys(kitPackage.dependencies ?? {}).length !== 0) {
    failures.push("kit/cli/package.json must not declare runtime dependencies");
  }
}

for (const removed of ["openclaw", "hermes"]) {
  if (existsSync(resolve(root, removed))) failures.push(`${removed}/ adapter directory must not exist`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[service-owned-boundary] ${failure}`);
  process.exit(1);
}
console.log("service-owned boundary check passed");
