import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ProfileDatabase } from "@hent-ai/shared/db";

const MIGRATION_MARKER = ".migrated-to-profiles";
const PROFILES_DIR = "profiles";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Default";

const EMOTION_FILES = [
  "happy.png",
  "neutral.png",
  "loyalty.png",
  "sorry.png",
  "confused.png",
  "focused.png",
];

interface LegacyManifest {
  version: number;
  activeSet: string;
  sets: Record<string, {
    name: string;
    character?: string;
    model?: string;
    createdAt: string;
    emotions: Record<string, string[]>;
  }>;
}

interface LegacyChannelOverrides {
  [channelId: string]: string;
}

function isAlreadyMigrated(imageDir: string): boolean {
  return existsSync(resolve(imageDir, MIGRATION_MARKER));
}

function markMigrated(imageDir: string): void {
  writeFileSync(resolve(imageDir, MIGRATION_MARKER), new Date().toISOString(), "utf-8");
}

function copyEmotionFiles(srcDir: string, dstDir: string): number {
  mkdirSync(dstDir, { recursive: true });
  let copied = 0;

  for (const file of EMOTION_FILES) {
    const src = resolve(srcDir, file);
    if (existsSync(src)) {
      copyFileSync(src, resolve(dstDir, file));
      copied++;
    }
  }

  const baseSrc = resolve(srcDir, "base.png");
  if (existsSync(baseSrc)) {
    copyFileSync(baseSrc, resolve(dstDir, "base.png"));
    copied++;
  }

  return copied;
}

function migrateFlatAssets(imageDir: string, db: ProfileDatabase): boolean {
  const hasAnyEmotionFile = EMOTION_FILES.some((f) => existsSync(resolve(imageDir, f)));
  if (!hasAnyEmotionFile) return false;

  const profileDir = resolve(imageDir, PROFILES_DIR, DEFAULT_PROFILE_ID);
  copyEmotionFiles(imageDir, profileDir);

  const existing = db.getProfile(DEFAULT_PROFILE_ID);
  if (!existing) {
    db.createProfile({ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME });
  }

  return true;
}

function migrateManifestSets(imageDir: string, db: ProfileDatabase): number {
  const manifestPath = resolve(imageDir, "manifest.json");
  if (!existsSync(manifestPath)) return 0;

  let manifest: LegacyManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as LegacyManifest;
  } catch {
    return 0;
  }

  let migrated = 0;
  for (const [setId, set] of Object.entries(manifest.sets)) {
    const profileId = setId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (db.getProfile(profileId)) continue;

    const setsDir = resolve(imageDir, "sets", setId);
    if (!existsSync(setsDir)) continue;

    const profileDir = resolve(imageDir, PROFILES_DIR, profileId);
    copyEmotionFiles(setsDir, profileDir);

    db.createProfile({
      id: profileId,
      name: set.name,
      character: set.character,
      model: set.model,
    });

    migrated++;
  }

  return migrated;
}

function migrateChannelOverrides(imageDir: string, db: ProfileDatabase): number {
  const overridesPath = resolve(imageDir, "channel-overrides.json");
  if (!existsSync(overridesPath)) return 0;

  let overrides: LegacyChannelOverrides;
  try {
    overrides = JSON.parse(readFileSync(overridesPath, "utf-8")) as LegacyChannelOverrides;
  } catch {
    return 0;
  }

  let migrated = 0;
  for (const [channelId, setId] of Object.entries(overrides)) {
    const profileId = setId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!db.getProfile(profileId)) continue;

    try {
      db.setChannelProfile(channelId, profileId);
      migrated++;
    } catch {
    }
  }

  return migrated;
}

export interface MigrationResult {
  skipped: boolean;
  flatAssetsMigrated: boolean;
  setsMigrated: number;
  channelOverridesMigrated: number;
}

export function runMigration(imageDir: string): MigrationResult {
  if (isAlreadyMigrated(imageDir)) {
    return { skipped: true, flatAssetsMigrated: false, setsMigrated: 0, channelOverridesMigrated: 0 };
  }

  const profilesDir = resolve(imageDir, PROFILES_DIR);
  if (existsSync(profilesDir)) {
    markMigrated(imageDir);
    return { skipped: true, flatAssetsMigrated: false, setsMigrated: 0, channelOverridesMigrated: 0 };
  }

  const db = new ProfileDatabase(imageDir);
  try {
    const flatAssetsMigrated = migrateFlatAssets(imageDir, db);
    const setsMigrated = migrateManifestSets(imageDir, db);
    const channelOverridesMigrated = migrateChannelOverrides(imageDir, db);

    markMigrated(imageDir);

    return {
      skipped: false,
      flatAssetsMigrated,
      setsMigrated,
      channelOverridesMigrated,
    };
  } finally {
    db.close();
  }
}
