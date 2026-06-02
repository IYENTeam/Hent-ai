import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ServiceDatabase } from "./db.js";
import { objectInputFromFile } from "./storage.js";

export type ImportReport = {
  dryRun: boolean;
  checksum: string;
  counts: {
    assetSets: number;
    assets: number;
    storageObjects: number;
    profiles: number;
    channelMappings: number;
  };
  mutations: boolean;
  warnings: string[];
};

type ManifestSet = {
  name?: string;
  character?: string;
  model?: string;
  emotions?: Record<string, string[]>;
};

type Manifest = {
  activeSet?: string;
  sets?: Record<string, ManifestSet>;
};

type ImportProfile = {
  id: string;
  name: string;
  character?: string | null;
  soulSnippet?: string | null;
  model?: string | null;
  manifest?: unknown;
};

type ImportAsset = {
  id: string;
  assetSetId: string;
  emotion: string;
  filename: string;
  path: string;
};

type ImportChannelMapping = {
  channelId: string;
  profileId?: string | null;
  mode?: string | null;
  enabled?: boolean | null;
  assetSetId?: string | null;
};

type LegacyState = {
  profiles: ImportProfile[];
  channelMappings: ImportChannelMapping[];
};

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif)$/i;

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function safeRows<T>(db: Database.Database, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return [];
  }
}

function profileNameFromId(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function listProfileDirectories(assetRoot: string): string[] {
  const profilesRoot = join(assetRoot, "profiles");
  if (!existsSync(profilesRoot)) return [];
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function listImageFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readLegacyState(assetRoot: string): LegacyState {
  const path = join(assetRoot, "hentai.db");
  if (!existsSync(path)) return { profiles: [], channelMappings: [] };

  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const profiles = safeRows<{
      id: string;
      name: string;
      character: string | null;
      soul_snippet: string | null;
      model: string | null;
    }>(db, "SELECT id, name, character, soul_snippet, model FROM profiles ORDER BY id").map((row) => ({
      id: row.id,
      name: row.name,
      character: row.character,
      soulSnippet: row.soul_snippet,
      model: row.model,
    }));

    const byChannel = new Map<string, ImportChannelMapping>();
    for (const row of safeRows<{ channel_id: string; profile_id: string }>(db, "SELECT channel_id, profile_id FROM channel_profiles ORDER BY channel_id")) {
      byChannel.set(row.channel_id, { channelId: row.channel_id, profileId: row.profile_id, assetSetId: row.profile_id });
    }
    for (const row of safeRows<{ channel_id: string; enabled: number | null; asset_set_id: string | null }>(db, "SELECT channel_id, enabled, asset_set_id FROM channel_settings ORDER BY channel_id")) {
      const existing = byChannel.get(row.channel_id) ?? { channelId: row.channel_id };
      existing.enabled = row.enabled == null ? null : row.enabled === 1;
      existing.assetSetId = row.asset_set_id ?? existing.assetSetId ?? null;
      if (!existing.profileId && row.asset_set_id) existing.profileId = row.asset_set_id;
      byChannel.set(row.channel_id, existing);
    }

    return { profiles, channelMappings: [...byChannel.values()] };
  } finally {
    db.close();
  }
}

function buildImportPlan(assetRoot: string, manifest: Manifest, channelOverrides: Record<string, unknown>): {
  profiles: ImportProfile[];
  assets: ImportAsset[];
  channelMappings: ImportChannelMapping[];
} {
  const profileMap = new Map<string, ImportProfile>();
  const assets: ImportAsset[] = [];
  const channelMap = new Map<string, ImportChannelMapping>();
  const legacy = readLegacyState(assetRoot);

  for (const profile of legacy.profiles) profileMap.set(profile.id, profile);

  for (const [setId, set] of Object.entries(manifest.sets ?? {})) {
    profileMap.set(setId, {
      ...profileMap.get(setId),
      id: setId,
      name: set.name ?? profileMap.get(setId)?.name ?? setId,
      character: set.character ?? profileMap.get(setId)?.character ?? null,
      soulSnippet: profileMap.get(setId)?.soulSnippet ?? null,
      model: set.model ?? profileMap.get(setId)?.model ?? null,
      manifest: set,
    });

    for (const [emotion, files] of Object.entries(set.emotions ?? {})) {
      for (const filename of files) {
        assets.push({
          id: `${setId}:${emotion}:${filename}`,
          assetSetId: setId,
          emotion,
          filename,
          path: join(assetRoot, "sets", setId, filename),
        });
      }
    }
  }

  for (const profileId of listProfileDirectories(assetRoot)) {
    profileMap.set(profileId, {
      id: profileId,
      name: profileMap.get(profileId)?.name ?? profileNameFromId(profileId),
      character: profileMap.get(profileId)?.character ?? null,
      soulSnippet: profileMap.get(profileId)?.soulSnippet ?? null,
      model: profileMap.get(profileId)?.model ?? null,
      manifest: profileMap.get(profileId)?.manifest,
    });

    for (const filename of listImageFiles(join(assetRoot, "profiles", profileId))) {
      const emotion = basename(filename).replace(/\.[^.]+$/, "");
      assets.push({
        id: `${profileId}:${emotion}:${filename}`,
        assetSetId: profileId,
        emotion,
        filename,
        path: join(assetRoot, "profiles", profileId, filename),
      });
    }
  }

  for (const mapping of legacy.channelMappings) channelMap.set(mapping.channelId, mapping);

  if (manifest.activeSet) {
    for (const [channelId, value] of Object.entries(channelOverrides).filter(([, value]) => value && typeof value === "object")) {
      const override = value as { profileId?: string; mode?: string; enabled?: boolean; assetSetId?: string };
      channelMap.set(channelId, {
        ...channelMap.get(channelId),
        channelId,
        profileId: override.profileId ?? channelMap.get(channelId)?.profileId ?? manifest.activeSet,
        mode: override.mode ?? channelMap.get(channelId)?.mode ?? null,
        enabled: override.enabled ?? channelMap.get(channelId)?.enabled ?? true,
        assetSetId: override.assetSetId ?? channelMap.get(channelId)?.assetSetId ?? manifest.activeSet,
      });
    }
  }

  return {
    profiles: [...profileMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    assets: assets.sort((a, b) => a.id.localeCompare(b.id)),
    channelMappings: [...channelMap.values()].sort((a, b) => a.channelId.localeCompare(b.channelId)),
  };
}

function digestImportInputs(assetRoot: string, manifest: Manifest, channelOverrides: unknown, plan: ReturnType<typeof buildImportPlan>): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(manifest));
  hash.update(JSON.stringify(channelOverrides));
  hash.update(JSON.stringify(plan.profiles));
  hash.update(JSON.stringify(plan.channelMappings));
  for (const asset of plan.assets) {
    hash.update(`${asset.assetSetId}/${asset.emotion}/${asset.filename}`);
    if (existsSync(asset.path)) hash.update(readFileSync(asset.path));
  }
  const legacyDb = join(assetRoot, "hentai.db");
  if (existsSync(legacyDb)) hash.update(readFileSync(legacyDb));
  return hash.digest("hex");
}

export function importAssets(options: { db: ServiceDatabase; assetRoot: string; dryRun?: boolean }): ImportReport {
  const dryRun = options.dryRun ?? false;
  const manifest = readJson<Manifest>(join(options.assetRoot, "manifest.json"), { sets: {} });
  const channelOverrides = readJson<Record<string, unknown>>(join(options.assetRoot, "channel-overrides.json"), {});
  const warnings: string[] = [];
  const plan = buildImportPlan(options.assetRoot, manifest, channelOverrides);
  const counts = {
    assetSets: plan.profiles.length,
    assets: 0,
    storageObjects: 0,
    profiles: plan.profiles.length,
    channelMappings: plan.channelMappings.length,
  };
  const checksum = digestImportInputs(options.assetRoot, manifest, channelOverrides, plan);

  for (const profile of plan.profiles) {
    if (!dryRun) {
      options.db.upsertAssetSet({ id: profile.id, name: profile.name, character: profile.character ?? null, model: profile.model ?? null, manifest: profile.manifest ?? {} });
      options.db.upsertProfile({ id: profile.id, name: profile.name, character: profile.character ?? null, soulSnippet: profile.soulSnippet ?? null, model: profile.model ?? null });
    }
  }

  for (const asset of plan.assets) {
    if (!existsSync(asset.path)) {
      warnings.push(`Missing asset file: ${asset.path}`);
      continue;
    }
    counts.assets += 1;
    counts.storageObjects += 1;
    if (!dryRun) {
      const objectInput = objectInputFromFile(options.assetRoot, asset.path, "imported");
      const storageObjectId = options.db.upsertStorageObject(objectInput);
      options.db.upsertAsset({
        id: asset.id,
        assetSetId: asset.assetSetId,
        emotion: asset.emotion,
        filename: asset.filename,
        storageObjectId,
        contentHash: objectInput.contentHash,
      });
    }
  }

  if (!dryRun) {
    for (const mapping of plan.channelMappings) {
      options.db.setChannelMapping(mapping.channelId, {
        profileId: mapping.profileId ?? null,
        mode: mapping.mode ?? null,
        enabled: mapping.enabled ?? true,
        assetSetId: mapping.assetSetId ?? mapping.profileId ?? null,
      });
    }
    options.db.recordImportRun(checksum, false, { counts, warnings });
  }
  return { dryRun, checksum, counts, mutations: !dryRun, warnings };
}

export function listImportableSetDirectories(assetRoot: string): string[] {
  const setsRoot = join(assetRoot, "sets");
  if (!existsSync(setsRoot)) return [];
  return readdirSync(setsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
