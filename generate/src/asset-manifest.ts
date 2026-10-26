import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { updateManifestFile } from "./manifest-update.js";

export interface AssetSet {
  name: string;
  character?: string;
  model?: string;
  createdAt: string;
  emotions: Record<string, string[]>;
}

export interface AssetManifest {
  version: 1;
  activeSet: string;
  sets: Record<string, AssetSet>;
}

const MANIFEST_FILENAME = "manifest.json";
const loadedManifests = new WeakMap<AssetManifest, string>();
const SETS_DIR = "sets";
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_PATH_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif)$/i;

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function assertSafeAssetSetId(setId: string): void {
  if (!SAFE_ID_RE.test(setId)) throw new Error("Invalid asset set id");
}

function assertSafeEmotionKey(emotion: string): void {
  if (!SAFE_ID_RE.test(emotion)) throw new Error("Invalid emotion key");
}

function assertSafeManifestFilename(filename: string): void {
  const segments = filename.split("/");
  if (
    filename.includes("\\")
    || segments.length === 0
    || segments.some((segment) => !SAFE_PATH_SEGMENT_RE.test(segment) || segment === "." || segment === "..")
    || !IMAGE_EXTENSION_RE.test(segments.at(-1) ?? "")
  ) {
    throw new Error("Invalid manifest filename");
  }
}

async function listAssetImagesRecursively(root: string, directory: string = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listAssetImagesRecursively(root, path));
    } else if (entry.isFile() && IMAGE_EXTENSION_RE.test(entry.name)) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

export async function loadManifest(imageDir: string): Promise<AssetManifest | null> {
  const manifestPath = resolve(imageDir, MANIFEST_FILENAME);
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as AssetManifest;
    loadedManifests.set(manifest, JSON.stringify(manifest));
    return manifest;
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
}

export async function saveManifest(imageDir: string, manifest: AssetManifest): Promise<void> {
  const manifestPath = resolve(imageDir, MANIFEST_FILENAME);
  const expected = loadedManifests.get(manifest);
  await updateManifestFile<AssetManifest>(manifestPath, (current) => {
    if (current && JSON.stringify(current) !== expected && JSON.stringify(current) !== JSON.stringify(manifest)) {
      throw new Error("Manifest changed since it was loaded; reload and retry the edit");
    }
    if (!current && expected) throw new Error("Manifest was removed since it was loaded; reload before saving");
    return manifest;
  });
  loadedManifests.set(manifest, JSON.stringify(manifest));
}

export function getSetDir(imageDir: string, setId: string): string {
  assertSafeAssetSetId(setId);
  return resolve(imageDir, SETS_DIR, setId);
}

export async function activateSet(
  imageDir: string,
  manifest: AssetManifest,
  setId: string,
): Promise<void> {
  assertSafeAssetSetId(setId);
  const set = manifest.sets[setId];
  if (!set) throw new Error(`Set "${setId}" not found in manifest`);

  manifest.activeSet = setId;
  for (const [emotion, files] of Object.entries(set.emotions)) {
    assertSafeEmotionKey(emotion);
    for (const filename of files) assertSafeManifestFilename(filename);
  }
  await saveManifest(imageDir, manifest);
}

export async function registerSet(
  imageDir: string,
  manifest: AssetManifest,
  setId: string,
  options: {
    name: string;
    character?: string;
    model?: string;
  },
): Promise<AssetSet> {
  assertSafeAssetSetId(setId);
  const setDir = getSetDir(imageDir, setId);
  if (!existsSync(setDir)) throw new Error(`Set directory not found: ${setDir}`);

  const files = await listAssetImagesRecursively(setDir);
  const emotions: Record<string, string[]> = {};
  for (const file of files) {
    if (file === "base.png") continue;
    const firstSegment = file.split("/")[0]!;
    const match = file.includes("/")
      ? firstSegment.match(/^([a-z]+)$/i)
      : file.match(/^([a-z]+)(?:[-_].+)?\.(png|jpe?g|webp|gif)$/i);
    if (!match) continue;
    const emotion = match[1].toLowerCase();
    assertSafeEmotionKey(emotion);
    assertSafeManifestFilename(file);
    emotions[emotion] = [...(emotions[emotion] ?? []), file];
  }

  for (const filesForEmotion of Object.values(emotions)) filesForEmotion.sort();

  const set: AssetSet = {
    name: options.name,
    character: options.character,
    model: options.model,
    createdAt: new Date().toISOString(),
    emotions,
  };
  manifest.sets[setId] = set;
  await saveManifest(imageDir, manifest);
  return set;
}

export function createEmptyManifest(): AssetManifest {
  return {
    version: 1,
    activeSet: "",
    sets: {},
  };
}

export function listSets(manifest: AssetManifest): Array<{
  id: string;
  name: string;
  active: boolean;
  emotionCount: number;
  totalFiles: number;
  createdAt: string;
}> {
  return Object.entries(manifest.sets).map(([id, set]) => ({
    id,
    name: set.name,
    active: manifest.activeSet === id,
    emotionCount: Object.keys(set.emotions).length,
    totalFiles: Object.values(set.emotions).reduce((sum, files) => sum + files.length, 0),
    createdAt: set.createdAt,
  }));
}
