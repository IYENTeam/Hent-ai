import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initializeServiceSchema } from "./db-schema.js";
import { rowToJob, rowToProfile } from "./db-rows.js";

export { SCHEMA_VERSION } from "./db-schema.js";

export type Profile = {
  id: string;
  name: string;
  character: string | null;
  soulSnippet: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProfileCreateInput = {
  id: string;
  name: string;
  character?: string | null;
  soulSnippet?: string | null;
  model?: string | null;
};

export type ProfileUpdateInput = Partial<Omit<ProfileCreateInput, "id">>;

export type ChannelMapping = {
  channelId: string;
  profileId: string | null;
  mode: string | null;
  enabled: boolean | null;
  cronEnabled: boolean | null;
  assetSetId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type StorageObjectInput = {
  storageKey: string;
  objectUrl: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
  provenance: string;
  localPath?: string | null;
  metadata?: unknown;
};

export type GenerationJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  request: unknown;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DiscordPollerState = {
  channelId: string;
  lastSeenMessageId: string;
  updatedAt: string;
};

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function now(): string {
  return new Date().toISOString();
}

export class ServiceDatabase {
  readonly db: Database.Database;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    if (path !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.initialize();
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

  getDiscordPollerState(channelId: string): DiscordPollerState | null {
    const row = this.db.prepare("SELECT channel_id, last_seen_message_id, updated_at FROM discord_poller_state WHERE channel_id = ?").get(channelId) as Record<string, unknown> | undefined;
    return row
      ? {
        channelId: String(row.channel_id),
        lastSeenMessageId: String(row.last_seen_message_id),
        updatedAt: String(row.updated_at),
      }
      : null;
  }

  listDiscordPollerState(): DiscordPollerState[] {
    return this.db.prepare("SELECT channel_id, last_seen_message_id, updated_at FROM discord_poller_state ORDER BY channel_id").all()
      .map((row) => ({
        channelId: String((row as Record<string, unknown>).channel_id),
        lastSeenMessageId: String((row as Record<string, unknown>).last_seen_message_id),
        updatedAt: String((row as Record<string, unknown>).updated_at),
      }));
  }

  setDiscordPollerState(channelId: string, lastSeenMessageId: string): void {
    const stamp = now();
    this.db.prepare(`INSERT INTO discord_poller_state (channel_id, last_seen_message_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET last_seen_message_id = excluded.last_seen_message_id, updated_at = excluded.updated_at`)
      .run(channelId, lastSeenMessageId, stamp);
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

  upsertAsset(input: { id: string; assetSetId: string; emotion: string; filename: string; storageObjectId: number; contentHash: string; metadata?: unknown }): void {
    const stamp = now();
    this.db.prepare(`INSERT INTO assets (id, asset_set_id, emotion, filename, storage_object_id, content_hash, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET asset_set_id = excluded.asset_set_id, emotion = excluded.emotion, filename = excluded.filename, storage_object_id = excluded.storage_object_id, content_hash = excluded.content_hash, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
      .run(input.id, input.assetSetId, input.emotion, input.filename, input.storageObjectId, input.contentHash, JSON.stringify(input.metadata ?? {}), stamp, stamp);
  }

  firstAssetForChannel(channelId: string): { filename: string; contentType: string; objectUrl: string; storageKey: string } | null {
    const mapping = this.getChannelMapping(channelId);
    if (!mapping || mapping.enabled === false || !mapping.assetSetId) return null;
    const row = this.db.prepare(`SELECT a.filename, o.content_type, o.object_url, o.storage_key
      FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id
      WHERE a.asset_set_id = ? ORDER BY CASE a.emotion WHEN 'neutral' THEN 0 ELSE 1 END, a.emotion, a.filename LIMIT 1`).get(mapping.assetSetId) as Record<string, unknown> | undefined;
    return row ? { filename: String(row.filename), contentType: String(row.content_type), objectUrl: String(row.object_url), storageKey: String(row.storage_key) } : null;
  }

  createGenerationJob(request: unknown): GenerationJob {
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const stamp = now();
    this.db.prepare(`INSERT INTO generation_jobs (id, status, request_json, result_json, error, created_at, updated_at)
      VALUES (?, 'queued', ?, NULL, NULL, ?, ?)`).run(id, JSON.stringify(request ?? {}), stamp, stamp);
    return this.getGenerationJob(id)!;
  }

  getGenerationJob(id: string): GenerationJob | null {
    const row = this.db.prepare("SELECT * FROM generation_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }
  claimNextGenerationJob(staleRunningBefore?: string): GenerationJob | null {
    const stamp = now();
    if (staleRunningBefore) {
      this.db.prepare("UPDATE generation_jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at <= ?")
        .run(stamp, staleRunningBefore);
    }
    const row = this.db.prepare("SELECT id FROM generation_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
    if (!row) return null;
    const result = this.db.prepare("UPDATE generation_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'").run(stamp, row.id);
    if (result.changes !== 1) return null;
    return this.getGenerationJob(row.id);
  }

  markGenerationJobSucceeded(id: string, resultValue: unknown): GenerationJob {
    const stamp = now();
    const result = this.db.prepare("UPDATE generation_jobs SET status = 'succeeded', result_json = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(JSON.stringify(resultValue ?? null), stamp, id);
    if (result.changes !== 1) throw new Error("Generation job is not running");
    return this.getGenerationJob(id)!;
  }

  markGenerationJobFailed(id: string, error: string): GenerationJob {
    const stamp = now();
    const result = this.db.prepare("UPDATE generation_jobs SET status = 'failed', result_json = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(error, stamp, id);
    if (result.changes !== 1) throw new Error("Generation job is not running");
    return this.getGenerationJob(id)!;
  }

  recordImportRun(checksum: string, dryRun: boolean, report: unknown): void {
    const id = `${checksum}:${dryRun ? "dry" : "apply"}`;
    this.db.prepare(`INSERT OR REPLACE INTO import_runs (id, checksum, dry_run, report_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, checksum, dryRun ? 1 : 0, JSON.stringify(report), now());
  }
}
