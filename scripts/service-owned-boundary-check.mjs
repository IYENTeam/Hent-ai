#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readText(path) {
  return readFileSync(resolve(root, path), "utf-8");
}

function fail(message) {
  console.error(`[service-owned-boundary] ${message}`);
  process.exitCode = 1;
}

const openclawPackage = JSON.parse(readText("openclaw/package.json"));
const expectedFiles = ["index.ts", "openclaw.plugin.json", "README.md"];
if (JSON.stringify(openclawPackage.files) !== JSON.stringify(expectedFiles)) {
  fail(`openclaw/package.json files must remain ${JSON.stringify(expectedFiles)}`);
}

if (Object.keys(openclawPackage.dependencies ?? {}).length !== 0) {
  fail("OpenClaw adapter package must not grow runtime dependencies");
}

const openclawTsconfig = JSON.parse(readText("openclaw/tsconfig.json"));
const allowedIncludes = ["index.ts", "scripts/*.ts"];
if (JSON.stringify(openclawTsconfig.include) !== JSON.stringify(allowedIncludes)) {
  fail(`openclaw/tsconfig.json include must stay ${JSON.stringify(allowedIncludes)}`);
}

const runtimeSurface = readText("openclaw/index.ts");
const forbiddenRuntimeTokens = [
  "ProfileDatabase",
  "loadManifest",
  "@hent-ai/generate",
  "discord.com",
  "createEmotionDetector",
  "dynamic-persona",
  "channel-filter",
  "date-mode",
  "migration",
];
for (const token of forbiddenRuntimeTokens) {
  if (runtimeSurface.includes(token)) fail(`openclaw/index.ts must not contain service-owned token: ${token}`);
}

const forbiddenRuntimeImports = new Set([
  "./discord-utils.js",
  "./profile-manager.js",
  "./assets/manifest.js",
  "./assets/channel-overrides.js",
  "./dynamic-persona.js",
  "./channel-filter.js",
  "./date-mode.js",
  "./migration.js",
  "@hent-ai/generate",
  "@hent-ai/shared/db",
]);

function importSpecifiers(source) {
  const specs = [];
  const importRe = /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importRe, dynamicImportRe]) {
    for (const match of source.matchAll(re)) specs.push(match[1]);
  }
  return specs;
}

function resolveLocalImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(root, dirname(fromFile), specifier);
  const extension = extname(base);
  const candidates = extension === ".js"
    ? [base, `${base.slice(0, -3)}.ts`]
    : extension
      ? [base]
      : [`${base}.ts`, `${base}.js`, resolve(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const visited = new Set();
const pending = ["openclaw/index.ts"];
for (let cursor = pending.shift(); cursor; cursor = pending.shift()) {
  if (visited.has(cursor)) continue;
  visited.add(cursor);
  const source = readText(cursor);
  for (const specifier of importSpecifiers(source)) {
    if (forbiddenRuntimeImports.has(specifier)) fail(`${cursor} must not import service-owned runtime helper: ${specifier}`);
    const local = resolveLocalImport(cursor, specifier);
    if (local) {
      const relative = local.slice(root.length + 1);
      if (relative.startsWith("openclaw/")) pending.push(relative);
    }
  }
}

const generateSets = readText("generate/src/sets.ts");
if (generateSets.includes("openclaw/assets/manifest")) {
  fail("generate/src/sets.ts must not import OpenClaw asset manifest internals");
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("[service-owned-boundary] passed");
