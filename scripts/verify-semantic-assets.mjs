#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const SCHEMA = "SemanticGenerationPlanV1";
const TAG_SCHEMA = "SemanticAssetTagsV1";
const TAG_COLLECTION_SCHEMA = "SemanticAssetTagCollectionV1";
const SET_ID = "gothic-semantic-v1";
const DEFAULT_PLAN = "assets/sets/gothic-semantic-v1/generation-plan.json";
const EMOTIONS = ["sorry", "happy", "confused", "focused", "loyalty", "neutral"];
const EXPECTED_EMOTION_COUNTS = [17, 17, 17, 17, 16, 16];
const AXES = ["gesture", "expression", "background", "clothing"];
const REFERENCES = [
  "assets/sets/gothic-v1/base.png",
  "assets/base_new.png",
  "assets/base_new3.png",
];

function fail(message) {
  throw new Error(`semantic asset verification failed: ${message}`);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("plan must be an object");
  if (plan.schemaVersion !== SCHEMA || plan.setId !== SET_ID) fail("plan schemaVersion or setId is invalid");
  if (plan.itemCount !== 100 || plan.batchSize !== 10 || !Array.isArray(plan.items) || plan.items.length !== 100) fail("plan must contain exactly 100 items in batches of 10");
  if (!sameArray(plan.references, REFERENCES)) fail("plan must use the approved three-reference bundle");
  if (!plan.controlledVocabularies || typeof plan.controlledVocabularies !== "object") fail("controlled vocabularies are missing");
  for (const axis of AXES) {
    const vocabulary = plan.controlledVocabularies[axis];
    if (!Array.isArray(vocabulary) || vocabulary.length !== 10 || new Set(vocabulary).size !== 10 || vocabulary.some((value) => typeof value !== "string" || value.trim() !== value || value.length === 0)) fail(`${axis} must define ten distinct normalized values`);
  }

  const filenames = new Set();
  const tuples = new Set();
  const emotionCounts = Object.fromEntries(EMOTIONS.map((emotion) => [emotion, 0]));
  const axisCounts = Object.fromEntries(AXES.map((axis) => [axis, Object.fromEntries(plan.controlledVocabularies[axis].map((value) => [value, 0]))]));
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index];
    const id = String(index).padStart(3, "0");
    const expectedEmotion = EMOTIONS[index % EMOTIONS.length];
    if (!item || item.index !== index || item.id !== id || item.batch !== Math.floor(index / 10)) fail(`item ${index} identity or batch is unstable`);
    if (item.emotion !== expectedEmotion || item.filename !== `${expectedEmotion}-${id}.png`) fail(`item ${index} emotion or filename is unstable`);
    if (!/^[a-z]+-\d{3}\.png$/.test(item.filename) || basename(item.filename) !== item.filename) fail(`item ${index} filename is unsafe`);
    for (const axis of AXES) {
      if (!(item[axis] in axisCounts[axis])) fail(`item ${index} has an uncontrolled ${axis}`);
      axisCounts[axis][item[axis]] += 1;
    }
    emotionCounts[item.emotion] += 1;
    filenames.add(item.filename);
    tuples.add(AXES.map((axis) => item[axis]).join("\u0000"));
  }
  if (filenames.size !== 100 || tuples.size !== 100) fail("filenames and four-axis tuples must be unique");
  if (!EMOTIONS.every((emotion, index) => emotionCounts[emotion] === EXPECTED_EMOTION_COUNTS[index])) fail("emotion coverage must be 17/17/17/17/16/16");
  for (const axis of AXES) {
    if (!Object.values(axisCounts[axis]).every((count) => count === 10)) fail(`each ${axis} value must appear ten times`);
  }
  return plan;
}

async function loadPlan(path) {
  return validatePlan(await readJson(path));
}

async function hashFile(path) {
  const buffer = await readFile(path);
  if (buffer.byteLength === 0) fail(`image is empty: ${path}`);
  return createHash("sha256").update(buffer).digest("hex");
}

async function verifyFiles(setDir, items) {
  const hashes = new Map();
  for (const item of items) {
    const path = resolve(setDir, item.filename);
    if (!existsSync(path)) fail(`missing planned image ${item.filename}`);
    const hash = await hashFile(path);
    const previous = hashes.get(hash);
    if (previous) fail(`duplicate image hash: ${previous} and ${item.filename}`);
    hashes.set(hash, item.filename);
  }
  return hashes;
}

async function listVisibleImages(root, directory = root) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listVisibleImages(root, path));
    else if (entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)) output.push(relative(root, path).split(sep).join("/"));
  }
  return output.sort();
}

function validateTags(value, item, plan) {
  const keys = ["schemaVersion", "emotion", ...AXES, "composition", "lighting", "mood"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || Object.keys(value).length !== keys.length) fail(`tags for ${item.filename} have unknown or missing fields`);
  if (value.schemaVersion !== TAG_SCHEMA || value.emotion !== item.emotion) fail(`tags for ${item.filename} have invalid schema or emotion`);
  for (const key of [...AXES, "composition", "lighting", "mood"]) {
    if (typeof value[key] !== "string" || value[key].trim() !== value[key] || value[key].length === 0 || value[key].length > 160) fail(`tags for ${item.filename} have invalid ${key}`);
  }
  for (const axis of AXES) {
    if (!plan.controlledVocabularies[axis].includes(value[axis])) fail(`tags for ${item.filename} use uncontrolled ${axis}`);
    if (value[axis] !== item[axis]) fail(`actual-image tags for ${item.filename} do not match planned ${axis}`);
  }
  return value;
}

async function verifyComplete(setDir, plan) {
  await verifyFiles(setDir, plan.items);
  const visibleImages = await listVisibleImages(setDir);
  const planned = plan.items.map((item) => item.filename).sort();
  if (!sameArray(visibleImages, planned)) fail("visible set images must be exactly the 100 planned finals; audit candidates belong under hidden .candidates");

  const collection = await readJson(resolve(setDir, "semantic-tags.json"));
  if (!collection || collection.schemaVersion !== TAG_COLLECTION_SCHEMA || !collection.items || Object.keys(collection.items).length !== 100) fail("semantic-tags.json must contain exactly 100 SemanticAssetTagCollectionV1 items");
  for (const item of plan.items) validateTags(collection.items[item.filename], item, plan);

  const manifestPath = resolve(setDir, "..", "..", "manifest.json");
  const manifest = await readJson(manifestPath);
  const set = manifest?.sets?.[SET_ID];
  if (!set) fail(`manifest does not register ${SET_ID}`);
  const manifestFiles = [];
  for (const emotion of EMOTIONS) {
    const expected = plan.items.filter((item) => item.emotion === emotion).map((item) => item.filename).sort();
    const actual = [...(set.emotions?.[emotion] ?? [])].sort();
    if (!sameArray(actual, expected)) fail(`manifest ${emotion} files do not match the complete plan`);
    manifestFiles.push(...actual);
  }
  if (manifestFiles.length !== 100 || Object.keys(set.emotions ?? {}).sort().join(",") !== [...EMOTIONS].sort().join(",")) fail("manifest must expose all six emotions and exactly 100 files");
  for (const item of plan.items) validateTags(set.semanticAssets?.[item.filename], item, plan);
}

async function main(argv) {
  const [mode, value] = argv;
  if (mode === "--plan-only") {
    if (!value || argv.length !== 2) fail("usage: --plan-only <generation-plan.json>");
    const planPath = resolve(value);
    const plan = await loadPlan(planPath);
    for (const reference of plan.references) if (!existsSync(resolve(reference))) fail(`missing approved reference ${reference}`);
    console.log(`semantic plan verified: ${plan.items.length} items, 10 batches, 4x10 controlled values`);
    return;
  }
  if (mode === "--batch") {
    if (!/^\d$/.test(value ?? "") || argv.length !== 2) fail("usage: --batch <0-9>");
    const planPath = resolve(DEFAULT_PLAN);
    const plan = await loadPlan(planPath);
    const batch = Number(value);
    const batchItems = plan.items.filter((item) => item.batch === batch);
    await verifyFiles(dirname(planPath), batchItems);
    console.log(`semantic batch verified: ${batch} (${batchItems[0].id}-${batchItems.at(-1).id})`);
    return;
  }
  if (mode === "--complete") {
    if (!value || argv.length !== 2) fail("usage: --complete <set-directory>");
    const setDir = resolve(value);
    const plan = await loadPlan(join(setDir, "generation-plan.json"));
    await verifyComplete(setDir, plan);
    console.log("semantic set verified: 100 images, unique hashes, tags, manifest, and measured four-axis coverage");
    return;
  }
  fail("usage: --plan-only <plan> | --batch <0-9> | --complete <set-directory>");
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
