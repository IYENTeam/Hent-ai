#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const DIMENSIONS = [
  "valence", "arousal", "dominance", "joy", "anger", "irritation", "sadness", "anxiety",
  "fear", "surprise", "confusion", "disgust", "embarrassment", "pride", "determination",
  "affection", "warmth", "playfulness", "teasing", "deference", "smileIntensity",
  "browTension", "eyeOpenness", "bodyOpenness",
];
const COLLECTION_SCHEMA = "VisualAffectCollectionV2";
const MODEL_LABEL = "gpt-5.6-sol-codex-visual-per-image";
const PROMPT_VERSION = "visual-affect-pixels-v3-per-image";

function usage() {
  throw new Error("Usage: codex-visual-affect-retag --source-root <asset-root> --set-id <set-id> --output-dir <dir> --codex-bin <path> [--model gpt-5.6-sol] [--batch-size 5] [--concurrency 3]");
}

function args(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) usage();
    values.set(key, value);
    index += 1;
  }
  for (const key of ["--source-root", "--set-id", "--output-dir", "--codex-bin"]) if (!values.get(key)) usage();
  const positive = (key, fallback) => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  return {
    sourceRoot: resolve(values.get("--source-root")),
    setId: values.get("--set-id"),
    outputDir: resolve(values.get("--output-dir")),
    codexBin: resolve(values.get("--codex-bin")),
    model: values.get("--model") ?? "gpt-5.6-sol",
    batchSize: positive("--batch-size", 5),
    concurrency: positive("--concurrency", 3),
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeFilename(value) {
  if (typeof value !== "string" || basename(value) !== value || !/^[^/\\\0]+\.(?:png|jpe?g|webp)$/i.test(value)) {
    throw new Error(`Unsafe asset filename: ${String(value)}`);
  }
  return value;
}

function parseAffect(value) {
  if (!isRecord(value)
    || value.schemaVersion !== "VisualAffectV2"
    || value.affectSpaceVersion !== "AffectSpaceV2"
    || !isRecord(value.dimensions)
    || Object.keys(value.dimensions).length !== DIMENSIONS.length
    || DIMENSIONS.some((key) => typeof value.dimensions[key] !== "number" || !Number.isFinite(value.dimensions[key]) || value.dimensions[key] < 0 || value.dimensions[key] > 1)
    || typeof value.confidence !== "number"
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
    || !Array.isArray(value.evidence)
    || value.evidence.length < 1
    || value.evidence.length > 4
    || value.evidence.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Codex output does not match VisualAffectV2");
  }
  return value;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeExclusiveOrResume(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== body) throw new Error(`Refusing to overwrite immutable tag: ${path}`);
  }
}

async function writeAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function run(command, commandArgs) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`Codex exited ${code ?? signal}: ${stderr}`)));
  });
}

function batchSchema(itemSchema, count) {
  const item = structuredClone(itemSchema);
  delete item.$schema;
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", minItems: count, maxItems: count, items: item } },
  };
}

async function tagBatch(config, files, itemSchema, batchNumber) {
  const temporary = await mkdtemp(join(tmpdir(), "hent-affect-retag-"));
  try {
    const anonymousPaths = [];
    for (let index = 0; index < files.length; index += 1) {
      const source = join(config.sourceRoot, "sets", config.setId, files[index]);
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Source image must be a regular file: ${source}`);
      const anonymous = join(temporary, `image-${String(index + 1).padStart(2, "0")}${extname(source).toLowerCase()}`);
      await copyFile(source, anonymous);
      anonymousPaths.push(anonymous);
    }
    const schemaPath = join(temporary, "batch.schema.json");
    const outputPath = join(temporary, "output.json");
    await writeFile(schemaPath, JSON.stringify(batchSchema(itemSchema, files.length)), { encoding: "utf8", mode: 0o600, flag: "wx" });
    const prompt = [
      `Inspect only the ${files.length} attached character images, in attachment order.`,
      `Return exactly ${files.length} VisualAffectV2 items in the same order.`,
      "Do not use tools and do not infer from any filename, directory, prompt, or intended label.",
      "Independently score each image's complete visible affect, mixed emotion, facial cues, gaze, posture, and social tone.",
      "Evidence must be concise and cite visible pixel cues only.",
    ].join(" ");
    await run(config.codexBin, [
      "exec", prompt, "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
      "--skip-git-repo-check", "--color", "never", "-C", process.cwd(), "-m", config.model,
      "-c", 'model_reasoning_effort="low"', "--output-schema", schemaPath, "--output-last-message", outputPath,
      "-i", ...anonymousPaths,
    ]);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    if (!isRecord(output) || !Array.isArray(output.items) || output.items.length !== files.length) throw new Error("Codex batch output count mismatch");
    const taggedAt = new Date().toISOString();
    for (let index = 0; index < files.length; index += 1) {
      const filename = files[index];
      const parsed = parseAffect(output.items[index]);
      const record = {
        ...parsed,
        source: {
          model: `${MODEL_LABEL}:${config.model}`,
          taggedAt,
          imageSha256: await sha256(join(config.sourceRoot, "sets", config.setId, filename)),
          promptVersion: PROMPT_VERSION,
        },
      };
      await writeExclusiveOrResume(join(config.outputDir, ".affect", `${filename.slice(0, -extname(filename).length)}.json`), record);
    }
    process.stdout.write(`${JSON.stringify({ batch: batchNumber, files: files.length, completed: files.at(-1) })}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const config = args(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(join(config.sourceRoot, "manifest.json"), "utf8"));
  const set = manifest?.sets?.[config.setId];
  if (!isRecord(set) || !isRecord(set.emotions)) throw new Error(`Source set not found: ${config.setId}`);
  const files = Object.values(set.emotions).flat().map(safeFilename).sort();
  if (files.length === 0 || new Set(files).size !== files.length) throw new Error("Source set images must be non-empty and unique");
  const schemaPath = resolve(import.meta.dirname, "..", "generate", "visual-affect-output.schema.json");
  const itemSchema = JSON.parse(await readFile(schemaPath, "utf8"));
  await mkdir(join(config.outputDir, ".affect"), { recursive: true, mode: 0o700 });

  const completed = new Map();
  for (const filename of files) {
    const tagPath = join(config.outputDir, ".affect", `${filename.slice(0, -extname(filename).length)}.json`);
    try {
      const record = parseAffect(JSON.parse(await readFile(tagPath, "utf8")));
      if (!record.source || record.source.imageSha256 !== await sha256(join(config.sourceRoot, "sets", config.setId, filename))) {
        throw new Error(`Stale provenance for ${filename}`);
      }
      completed.set(filename, record);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const pending = files.filter((filename) => !completed.has(filename));
  const batches = Array.from({ length: Math.ceil(pending.length / config.batchSize) }, (_, index) => pending.slice(index * config.batchSize, (index + 1) * config.batchSize));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(config.concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const batchNumber = next++;
      await tagBatch(config, batches[batchNumber], itemSchema, batchNumber + 1);
    }
  }));

  const items = {};
  for (const filename of files) {
    const tagPath = join(config.outputDir, ".affect", `${filename.slice(0, -extname(filename).length)}.json`);
    const record = parseAffect(JSON.parse(await readFile(tagPath, "utf8")));
    if (!record.source || record.source.imageSha256 !== await sha256(join(config.sourceRoot, "sets", config.setId, filename))) throw new Error(`Invalid final provenance for ${filename}`);
    items[filename] = record;
  }
  const collection = { schemaVersion: COLLECTION_SCHEMA, affectSpaceVersion: "AffectSpaceV2", items };
  await writeAtomic(join(config.outputDir, "affect-vectors.json"), collection);
  const vectors = new Set(Object.values(items).map((item) => JSON.stringify(DIMENSIONS.map((key) => item.dimensions[key]))));
  process.stdout.write(`${JSON.stringify({ files: files.length, distinctVectors: vectors.size, output: join(config.outputDir, "affect-vectors.json") })}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
