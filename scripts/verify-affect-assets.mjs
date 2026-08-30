#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const dimensions = [
  "valence", "arousal", "dominance", "joy", "anger", "irritation", "sadness", "anxiety", "fear", "surprise", "confusion", "disgust",
  "embarrassment", "pride", "determination", "affection", "warmth", "playfulness", "teasing", "deference", "smileIntensity", "browTension", "eyeOpenness", "bodyOpenness",
];
const acceptedPromptVersions = new Set(["visual-affect-pixels-v2", "visual-affect-pixels-v3-per-image"]);

function fail(message) {
  throw new Error(`affect asset verification failed: ${message}`);
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validUnit(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateAffect(filename, value, hash) {
  if (!value || value.schemaVersion !== "VisualAffectV2" || value.affectSpaceVersion !== "AffectSpaceV2") fail(`${filename}: invalid schema`);
  if (!value.dimensions || Object.keys(value.dimensions).sort().join("\0") !== [...dimensions].sort().join("\0")) fail(`${filename}: dimensions differ from AffectSpaceV2`);
  for (const dimension of dimensions) if (!validUnit(value.dimensions[dimension])) fail(`${filename}: invalid ${dimension}`);
  if (!validUnit(value.confidence) || !Array.isArray(value.evidence) || value.evidence.length === 0) fail(`${filename}: confidence or evidence is invalid`);
  if (!value.source || value.source.imageSha256 !== hash || typeof value.source.model !== "string" || typeof value.source.taggedAt !== "string" || !acceptedPromptVersions.has(value.source.promptVersion)) fail(`${filename}: provenance is invalid`);
}

async function main(argv) {
  if (argv.length !== 2) fail("usage: verify-affect-assets.mjs <asset-root> <set-id>");
  const assetRoot = resolve(argv[0]);
  const setId = argv[1];
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(setId)) fail("unsafe set id");
  const manifest = await json(join(assetRoot, "manifest.json"));
  const set = manifest?.sets?.[setId];
  if (!set || set.affectSpaceVersion !== "AffectSpaceV2" || set.visualAffectSchema !== "VisualAffectV2") fail(`manifest set is not VisualAffectV2: ${setId}`);
  const files = Object.values(set.emotions ?? {}).flat();
  if (files.length !== 100 || new Set(files).size !== 100) fail("set must expose exactly 100 unique images");
  if (!set.affectAssets || Object.keys(set.affectAssets).length !== 100) fail("set must contain exactly 100 affect tags");

  const setDirectory = join(assetRoot, "sets", setId);
  const visible = (await readdir(setDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(visible) !== JSON.stringify([...files].sort())) fail("manifest and visible image files differ");

  const aggregate = createHash("sha256");
  for (const filename of [...files].sort()) {
    if (basename(filename) !== filename || !existsSync(join(setDirectory, filename))) fail(`unsafe or missing image: ${filename}`);
    const bytes = await readFile(join(setDirectory, filename));
    const hash = createHash("sha256").update(bytes).digest("hex");
    validateAffect(filename, set.affectAssets[filename], hash);
    aggregate.update(`${filename}\0${hash}\n`);
  }
  console.log(JSON.stringify({ assetRoot, setId, files: files.length, active: manifest.activeSet === setId, checksum: aggregate.digest("hex") }));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
