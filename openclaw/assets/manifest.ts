import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

export interface AssetSetEmotion {
  /** Filenames relative to the set directory */
  files: string[];
}

export interface AssetSet {
  /** Human-readable name */
  name: string;
  /** Character description used for generation */
  character?: string;
  /** Model used for generation */
  model?: string;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** Emotion → file list mapping */
  emotions: Record<string, string[]>;
}

export interface AssetManifest {
  version: 1;
  /** Currently active set id */
  activeSet: string;
  /** All registered sets */
  sets: Record<string, AssetSet>;
}

const MANIFEST_FILENAME = "manifest.json";
const SETS_DIR = "sets";

export const DEFAULT_EMOTIONS = [
  "happy",
  "neutral",
  "loyalty",
  "sorry",
  "confused",
  "focused",
] as const;

/**
 * Load manifest from the given imageDir (async). Returns null if not found.
 */
export async function loadManifest(imageDir: string): Promise<AssetManifest | null> {
  const manifestPath = resolve(imageDir, MANIFEST_FILENAME);
  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as AssetManifest;
  } catch {
    return null;
  }
}

/**
 * Load manifest synchronously (for plugin register which is not async).
 */
export function loadManifestSync(imageDir: string): AssetManifest | null {
  const manifestPath = resolve(imageDir, MANIFEST_FILENAME);
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as AssetManifest;
  } catch {
    return null;
  }
}

/**
 * Save manifest to disk.
 */
export async function saveManifest(imageDir: string, manifest: AssetManifest): Promise<void> {
  const manifestPath = resolve(imageDir, MANIFEST_FILENAME);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Get the directory path for a set.
 */
export function getSetDir(imageDir: string, setId: string): string {
  return resolve(imageDir, SETS_DIR, setId);
}

/**
 * Get the active set, or null if manifest/set is missing.
 */
export function getActiveSet(manifest: AssetManifest): { id: string; set: AssetSet } | null {
  const set = manifest.sets[manifest.activeSet];
  if (!set) return null;
  return { id: manifest.activeSet, set };
}

/**
 * Build an emotionMap-compatible config from a manifest's active set.
 * Returns filename paths relative to imageDir (e.g., "sets/gothic-v1/happy.png").
 */
export function buildEmotionMapFromSet(
  setId: string,
  set: AssetSet,
): Record<string, Array<{ file: string; weight: number }>> {
  const result: Record<string, Array<{ file: string; weight: number }>> = {};

  for (const [emotion, files] of Object.entries(set.emotions)) {
    result[emotion] = files.map((file) => ({
      file: join(SETS_DIR, setId, file),
      weight: 1,
    }));
  }

  return result;
}

/**
 * Activate a set: update manifest.activeSet and copy files to root imageDir
 * for backward compatibility (flat happy.png, neutral.png, etc.).
 */
export async function activateSet(
  imageDir: string,
  manifest: AssetManifest,
  setId: string,
): Promise<void> {
  const set = manifest.sets[setId];
  if (!set) throw new Error(`Set "${setId}" not found in manifest`);

  manifest.activeSet = setId;
  const setDir = getSetDir(imageDir, setId);

  // Copy first file of each emotion to root for backward compat
  for (const [emotion, files] of Object.entries(set.emotions)) {
    if (files.length === 0) continue;
    const src = resolve(setDir, files[0]);
    const dst = resolve(imageDir, `${emotion}.png`);
    if (existsSync(src)) {
      await copyFile(src, dst);
    }
  }

  // Copy base if exists
  const baseSrc = resolve(setDir, "base.png");
  if (existsSync(baseSrc)) {
    await copyFile(baseSrc, resolve(imageDir, "base.png"));
  }

  await saveManifest(imageDir, manifest);
}

/**
 * Register a new set from a directory of images.
 * Scans the directory for emotion PNGs and creates the set entry.
 */
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
  const setDir = getSetDir(imageDir, setId);
  if (!existsSync(setDir)) {
    throw new Error(`Set directory not found: ${setDir}`);
  }

  const files = await readdir(setDir);
  const emotions: Record<string, string[]> = {};

  for (const file of files) {
    if (!/\.(png|jpe?g|webp|gif)$/i.test(file)) continue;
    if (file === "base.png") continue;

    // Match emotion name: "happy.png", "happy-v2.png", "happy_alt.png"
    const match = file.match(/^([a-z]+)(?:[-_].+)?\.(png|jpe?g|webp|gif)$/i);
    if (!match) continue;

    const emotion = match[1].toLowerCase();
    if (!emotions[emotion]) emotions[emotion] = [];
    emotions[emotion].push(file);
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

/**
 * Create a fresh manifest (for first-time setup).
 */
export function createEmptyManifest(): AssetManifest {
  return {
    version: 1,
    activeSet: "",
    sets: {},
  };
}

/**
 * Add image files to an existing set's emotion.
 */
export async function addFilesToSet(
  imageDir: string,
  manifest: AssetManifest,
  setId: string,
  emotion: string,
  filenames: string[],
): Promise<void> {
  const set = manifest.sets[setId];
  if (!set) throw new Error(`Set "${setId}" not found`);

  if (!set.emotions[emotion]) set.emotions[emotion] = [];
  for (const f of filenames) {
    if (!set.emotions[emotion].includes(f)) {
      set.emotions[emotion].push(f);
    }
  }

  await saveManifest(imageDir, manifest);
}

/**
 * List all sets with summary info.
 */
export function listSets(manifest: AssetManifest): Array<{
  id: string;
  name: string;
  active: boolean;
  emotionCount: number;
  totalFiles: number;
  createdAt: string;
}> {
  return Object.entries(manifest.sets).map(([id, set]) => {
    const totalFiles = Object.values(set.emotions).reduce((sum, f) => sum + f.length, 0);
    return {
      id,
      name: set.name,
      active: manifest.activeSet === id,
      emotionCount: Object.keys(set.emotions).length,
      totalFiles,
      createdAt: set.createdAt,
    };
  });
}
