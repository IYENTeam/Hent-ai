import Database from "better-sqlite3";
import { initializeServiceSchema } from "./db-schema.js";
import { prepareDatabasePath, secureDatabaseFiles } from "./db-file-security.js";
import { rowToProfile, rowToStoredSemanticAssetCandidate } from "./db-rows.js";
import type { AssetUpsertInput, ChannelMapping, Profile, ProfileCreateInput, ProfileUpdateInput, StorageObjectInput, StoredSemanticAssetCandidate } from "./db-types.js";

export type { AssetUpsertInput, ChannelMapping, Profile, ProfileCreateInput, ProfileUpdateInput, StorageObjectInput, StoredSemanticAssetCandidate } from "./db-types.js";

export { SCHEMA_VERSION } from "./db-schema.js";

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function now(): string {
  return new Date().toISOString();
}

export class ServiceDatabase {
  readonly db: Database.Database;

  constructor(path = ":memory:") {
    if (path !== ":memory:") prepareDatabasePath(path);
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    if (path !== ":memory:") this.db.pragma("journal_mode = WAL");
    if (path !== ":memory:") this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.initialize();
    if (path !== ":memory:") secureDatabaseFiles(path);
  }

  close(): void {
    this.db.close();
  }

  initialize(): void {
    initializeServiceSchema(this.db, now());
  }

  tableNames(): string[] {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => (row as { name: string }).name);
  }

  listProfiles(): Profile[] {
    return this.db.prepare("SELECT * FROM profiles ORDER BY id").all().map((row) => rowToProfile(row as Record<string, unknown>));
  }

  getProfile(id: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToProfile(row) : null;
  }

  createProfile(input: ProfileCreateInput): Profile {
    if (!PROFILE_ID_RE.test(input.id) || input.id.includes("..")) throw new Error("Invalid profile id");
    if (!input.name) throw new Error("Profile name is required");
    const stamp = now();
    this.db.prepare(`INSERT INTO profiles (id, name, character, soul_snippet, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.name, input.character ?? null, input.soulSnippet ?? null, input.model ?? null, stamp, stamp);
    return this.getProfile(input.id)!;
  }

  upsertProfile(input: ProfileCreateInput): Profile {
    const existing = this.getProfile(input.id);
    return existing ? this.updateProfile(input.id, input) : this.createProfile(input);
  }

  updateProfile(id: string, input: ProfileUpdateInput): Profile {
    const existing = this.getProfile(id);
    if (!existing) throw new Error("Profile not found");
    const fields: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
    if (input.character !== undefined) { fields.push("character = ?"); values.push(input.character); }
    if (input.soulSnippet !== undefined) { fields.push("soul_snippet = ?"); values.push(input.soulSnippet); }
    if (input.model !== undefined) { fields.push("model = ?"); values.push(input.model); }
    if (fields.length === 0) return existing;
    fields.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE profiles SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getProfile(id)!;
  }

  setChannelMapping(channelId: string, input: { profileId?: string | null; mode?: string | null; enabled?: boolean | null; cronEnabled?: boolean | null; assetSetId?: string | null; settings?: unknown }): ChannelMapping {
    const stamp = now();
    if (input.profileId && !this.getProfile(input.profileId)) throw new Error("Profile not found");
    this.db.prepare(`INSERT INTO channel_mappings (channel_id, profile_id, mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET profile_id = excluded.profile_id, mode = excluded.mode, updated_at = excluded.updated_at`)
      .run(channelId, input.profileId ?? null, input.mode ?? null, stamp, stamp);
    this.db.prepare(`INSERT INTO channel_settings (channel_id, enabled, cron_enabled, asset_set_id, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET enabled = excluded.enabled, cron_enabled = excluded.cron_enabled, asset_set_id = excluded.asset_set_id, settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
      .run(
        channelId,
        input.enabled == null ? null : input.enabled ? 1 : 0,
        input.cronEnabled == null ? null : input.cronEnabled ? 1 : 0,
        input.assetSetId ?? null,
        JSON.stringify(input.settings ?? {}),
        stamp,
        stamp,
      );
    return this.getChannelMapping(channelId)!;
  }

  getChannelMapping(channelId: string): ChannelMapping | null {
    const row = this.db.prepare(`SELECT m.channel_id, m.profile_id, m.mode, m.created_at, m.updated_at, s.enabled, s.cron_enabled, s.asset_set_id
      FROM channel_mappings m LEFT JOIN channel_settings s ON s.channel_id = m.channel_id WHERE m.channel_id = ?`).get(channelId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      channelId: String(row.channel_id),
      profileId: (row.profile_id as string | null) ?? null,
      mode: (row.mode as string | null) ?? null,
      enabled: row.enabled == null ? null : Number(row.enabled) === 1,
      cronEnabled: row.cron_enabled == null ? null : Number(row.cron_enabled) === 1,
      assetSetId: (row.asset_set_id as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listCronEnabledChannels(): Array<{ channelId: string; profileId: string | null; assetSetId: string | null; updatedAt: string | null }> {
    return this.db.prepare(`SELECT m.channel_id, m.profile_id, s.asset_set_id, COALESCE(s.updated_at, m.updated_at) AS updated_at
      FROM channel_mappings m
      JOIN channel_settings s ON s.channel_id = m.channel_id
      WHERE s.cron_enabled = 1
      ORDER BY m.channel_id`).all().map((row) => ({
      channelId: String((row as { channel_id: string }).channel_id),
      profileId: ((row as { profile_id?: string | null }).profile_id) ?? null,
      assetSetId: ((row as { asset_set_id?: string | null }).asset_set_id) ?? null,
      updatedAt: ((row as { updated_at?: string | null }).updated_at) ?? null,
    }));
  }

  listChannelSettings(): Array<{ channelId: string; profileId: string | null; mode: string | null; enabled: boolean | null; cronEnabled: boolean | null; assetSetId: string | null; settings: unknown; updatedAt: string }> {
    return this.db.prepare(`SELECT s.channel_id, m.profile_id, m.mode, s.enabled, s.cron_enabled, s.asset_set_id, s.settings_json, s.updated_at
      FROM channel_settings s LEFT JOIN channel_mappings m ON m.channel_id = s.channel_id
      ORDER BY s.channel_id`).all().map((value) => {
      const row = value as Record<string, unknown>;
      return {
        channelId: String(row.channel_id),
        profileId: (row.profile_id as string | null) ?? null,
        mode: (row.mode as string | null) ?? null,
        enabled: row.enabled == null ? null : Number(row.enabled) === 1,
        cronEnabled: row.cron_enabled == null ? null : Number(row.cron_enabled) === 1,
        assetSetId: (row.asset_set_id as string | null) ?? null,
        settings: typeof row.settings_json === "string" ? JSON.parse(row.settings_json) as unknown : null,
        updatedAt: String(row.updated_at),
      };
    });
  }

  cronEnabledRevision(): string {
    const row = this.db.prepare(`SELECT COALESCE(MAX(COALESCE(updated_at, created_at)), '') AS revision
      FROM channel_settings
      WHERE cron_enabled = 1`).get() as { revision: string };
    return row.revision || "";
  }

  upsertAssetSet(input: { id: string; name: string; character?: string | null; model?: string | null; manifest?: unknown }): void {
    const stamp = now();
    this.db.prepare(`INSERT INTO asset_sets (id, name, character, model, manifest_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, character = excluded.character, model = excluded.model, manifest_json = excluded.manifest_json, updated_at = excluded.updated_at`)
      .run(input.id, input.name, input.character ?? null, input.model ?? null, JSON.stringify(input.manifest ?? {}), stamp, stamp);
  }

  upsertStorageObject(input: StorageObjectInput): number {
    const stamp = now();
    this.db.prepare(`INSERT INTO storage_objects (storage_key, object_url, content_hash, content_type, size_bytes, provenance, local_path, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(storage_key) DO UPDATE SET object_url = excluded.object_url, content_hash = excluded.content_hash, content_type = excluded.content_type, size_bytes = excluded.size_bytes, provenance = excluded.provenance, local_path = excluded.local_path, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
      .run(input.storageKey, input.objectUrl, input.contentHash, input.contentType, input.sizeBytes, input.provenance, input.localPath ?? null, JSON.stringify(input.metadata ?? {}), stamp, stamp);
    return (this.db.prepare("SELECT id FROM storage_objects WHERE storage_key = ?").get(input.storageKey) as { id: number }).id;
  }

  upsertAsset(input: AssetUpsertInput): void {
    const stamp = now();
    this.db.prepare(`INSERT INTO assets (id, asset_set_id, emotion, filename, storage_object_id, content_hash, metadata_json, semantic_tags_json, semantic_vector_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET asset_set_id = excluded.asset_set_id, emotion = excluded.emotion, filename = excluded.filename, storage_object_id = excluded.storage_object_id, content_hash = excluded.content_hash, metadata_json = excluded.metadata_json, semantic_tags_json = excluded.semantic_tags_json, semantic_vector_json = excluded.semantic_vector_json, updated_at = excluded.updated_at`)
      .run(
        input.id,
        input.assetSetId,
        input.emotion,
        input.filename,
        input.storageObjectId,
        input.contentHash,
        JSON.stringify(input.metadata ?? {}),
        input.semanticTags == null ? null : JSON.stringify(input.semanticTags),
        input.semanticVector == null ? null : JSON.stringify(input.semanticVector),
        stamp,
        stamp,
      );
  }

  listAssetsForSetEmotion(assetSetId: string, emotion: string): StoredSemanticAssetCandidate[] {
    return this.db.prepare(`SELECT a.id, a.asset_set_id, a.emotion, a.filename, a.semantic_tags_json, a.semantic_vector_json,
        o.content_type, o.object_url, o.storage_key
      FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id
      WHERE a.asset_set_id = ? AND lower(a.emotion) = ?
      ORDER BY a.filename, a.id`)
      .all(assetSetId, emotion.toLowerCase())
      .map((row) => rowToStoredSemanticAssetCandidate(row as Record<string, unknown>));
  }

  listAssetsForSet(assetSetId: string): StoredSemanticAssetCandidate[] {
    return this.db.prepare(`SELECT a.id, a.asset_set_id, a.emotion, a.filename, a.semantic_tags_json, a.semantic_vector_json,
        o.content_type, o.object_url, o.storage_key
      FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id
      WHERE a.asset_set_id = ?
      ORDER BY a.filename, a.id`)
      .all(assetSetId)
      .map((row) => rowToStoredSemanticAssetCandidate(row as Record<string, unknown>));
  }

  /** Newest asset timestamp in a set: the semantic router's cache revision for its generate threshold. */
  assetSetRevision(assetSetId: string): string | null {
    const row = this.db.prepare("SELECT MAX(updated_at) AS revision FROM assets WHERE asset_set_id = ?").get(assetSetId) as { revision: string | null };
    return row.revision ?? null;
  }

  firstAssetForChannel(channelId: string): { filename: string; contentType: string; objectUrl: string; storageKey: string } | null {
    const mapping = this.getChannelMapping(channelId);
    if (!mapping || mapping.enabled === false || !mapping.assetSetId) return null;
    const row = this.db.prepare(`SELECT a.filename, o.content_type, o.object_url, o.storage_key
      FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id
      WHERE a.asset_set_id = ? ORDER BY CASE a.emotion WHEN 'neutral' THEN 0 ELSE 1 END, a.emotion, a.filename LIMIT 1`).get(mapping.assetSetId) as Record<string, unknown> | undefined;
    return row ? { filename: String(row.filename), contentType: String(row.content_type), objectUrl: String(row.object_url), storageKey: String(row.storage_key) } : null;
  }

  firstAssetForChannelEmotion(channelId: string, emotion: string): { filename: string; contentType: string; objectUrl: string; storageKey: string } | null {
    const mapping = this.getChannelMapping(channelId);
    if (!mapping || mapping.enabled === false || !mapping.assetSetId) return null;
    const row = this.db.prepare(`SELECT a.filename, o.content_type, o.object_url, o.storage_key
      FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id
      WHERE a.asset_set_id = ? AND lower(a.emotion) = ? ORDER BY a.filename LIMIT 1`)
      .get(mapping.assetSetId, emotion.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? { filename: String(row.filename), contentType: String(row.content_type), objectUrl: String(row.object_url), storageKey: String(row.storage_key) } : null;
  }

  recordImportRun(checksum: string, dryRun: boolean, report: unknown): void {
    const id = `${checksum}:${dryRun ? "dry" : "apply"}`;
    this.db.prepare(`INSERT OR REPLACE INTO import_runs (id, checksum, dry_run, report_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, checksum, dryRun ? 1 : 0, JSON.stringify(report), now());
  }
}
