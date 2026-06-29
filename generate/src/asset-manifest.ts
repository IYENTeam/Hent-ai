import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
const SETS_DIR = "sets";
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_FILENAME_RE = /^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp|gif)$/i;

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
  if (!SAFE_FILENAME_RE.test(filename) || filename.includes("/") || filename.includes("\\")) {
    throw new Error("Invalid manifest filename");
  }
}

export async function loadManifest(imageDir: string): Promise<AssetManifest | null> {
  const manifestPath = resolve(imageDir, MANIFEST_FILENAME);
  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as AssetManifest;
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
}

export async function saveManifest(imageDir: string, manifest: AssetManifest): Promise<void> {
  await mkdir(imageDir, { recursive: true });
  const manifestPath = resolve(imageDir, MANIFEST_FILENAME);
  const tempPath = resolve(
    imageDir,
    `${MANIFEST_FILENAME}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  await rename(tempPath, manifestPath);
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

  const files = await readdir(setDir);
  const emotions: Record<string, string[]> = {};
  for (const file of files) {
    if (!/\.(png|jpe?g|webp|gif)$/i.test(file)) continue;
    if (file === "base.png") continue;
    const match = file.match(/^([a-z]+)(?:[-_].+)?\.(png|jpe?g|webp|gif)$/i);
    if (!match) continue;
    const emotion = match[1].toLowerCase();
    assertSafeEmotionKey(emotion);
    assertSafeManifestFilename(file);
    emotions[emotion] = [...(emotions[emotion] ?? []), file];
  }

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
