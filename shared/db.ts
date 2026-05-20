// Synchronous SQLite storage via better-sqlite3 — fits the plugin lifecycle
// (startup init, infrequent writes, fast reads).

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  Profile,
  ProfileCreateInput,
  ProfileUpdateInput,
  ChannelProfileMapping,
} from "./profile.js";
import { validateProfileId } from "./profile.js";

const DB_FILENAME = "hentai.db";
const SCHEMA_VERSION = 2;

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  character TEXT,
  soul_snippet TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_profiles (
  channel_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_settings (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (profile_id, key)
);
`;

const MIGRATION_V2_SQL = `
ALTER TABLE profiles ADD COLUMN mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE profiles ADD COLUMN chat_prompt TEXT;
`;

function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    id: row.id as string,
    name: row.name as string,
    character: (row.character as string) ?? null,
    soulSnippet: (row.soul_snippet as string) ?? null,
    chatPrompt: (row.chat_prompt as string) ?? null,
    mode: ((row.mode as string) ?? "default") as Profile["mode"],
    model: (row.model as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class ProfileDatabase {
  private db: Database.Database;

  constructor(imageDir: string) {
    mkdirSync(imageDir, { recursive: true });
    const dbPath = resolve(imageDir, DB_FILENAME);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  static fromDatabase(db: Database.Database): ProfileDatabase {
    const instance = Object.create(ProfileDatabase.prototype) as ProfileDatabase;
    instance.db = db;
    db.pragma("foreign_keys = ON");
    instance.initialize();
    return instance;
  }

  private initialize(): void {
    const versionRow = (() => {
      try {
        return this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
          | { version: number }
          | undefined;
      } catch {
        return undefined;
      }
    })();

    if (!versionRow) {
      this.db.exec(SCHEMA_V1_SQL);
      this.db.exec(MIGRATION_V2_SQL);
      this.db
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(SCHEMA_VERSION);
    } else if (versionRow.version < 2) {
      this.db.exec(MIGRATION_V2_SQL);
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    }
  }

  // ── Profile CRUD ──────────────────────────────────────────────

  createProfile(input: ProfileCreateInput): Profile {
    if (!validateProfileId(input.id)) {
      throw new Error(`Invalid profile ID: "${input.id}"`);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, character, soul_snippet, chat_prompt, mode, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.character ?? null,
        input.soulSnippet ?? null,
        input.chatPrompt ?? null,
        input.mode ?? "default",
        input.model ?? null,
        now,
        now,
      );

    return this.getProfile(input.id)!;
  }

  getProfile(id: string): Profile | null {
    const row = this.db
      .prepare("SELECT * FROM profiles WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToProfile(row) : null;
  }

  updateProfile(id: string, input: ProfileUpdateInput): Profile {
    const existing = this.getProfile(id);
    if (!existing) {
      throw new Error(`Profile not found: "${id}"`);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(input.name);
    }
    if (input.character !== undefined) {
      fields.push("character = ?");
      values.push(input.character);
    }
    if (input.soulSnippet !== undefined) {
      fields.push("soul_snippet = ?");
      values.push(input.soulSnippet);
    }
    if (input.chatPrompt !== undefined) {
      fields.push("chat_prompt = ?");
      values.push(input.chatPrompt);
    }
    if (input.mode !== undefined) {
      fields.push("mode = ?");
      values.push(input.mode);
    }
    if (input.model !== undefined) {
      fields.push("model = ?");
      values.push(input.model);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db
      .prepare(`UPDATE profiles SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getProfile(id)!;
  }

  deleteProfile(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM profiles WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  listProfiles(): Profile[] {
    const rows = this.db
      .prepare("SELECT * FROM profiles ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToProfile);
  }

  // ── Channel Mapping ───────────────────────────────────────────

  setChannelProfile(channelId: string, profileId: string): void {
    const profile = this.getProfile(profileId);
    if (!profile) {
      throw new Error(`Profile not found: "${profileId}"`);
    }

    this.db
      .prepare(
        `INSERT INTO channel_profiles (channel_id, profile_id)
         VALUES (?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET profile_id = excluded.profile_id`,
      )
      .run(channelId, profileId);
  }

  getChannelProfile(channelId: string): string | null {
    const row = this.db
      .prepare("SELECT profile_id FROM channel_profiles WHERE channel_id = ?")
      .get(channelId) as { profile_id: string } | undefined;
    return row?.profile_id ?? null;
  }

  removeChannelProfile(channelId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM channel_profiles WHERE channel_id = ?")
      .run(channelId);
    return result.changes > 0;
  }

  listChannelProfiles(): ChannelProfileMapping[] {
    const rows = this.db
      .prepare("SELECT channel_id, profile_id FROM channel_profiles ORDER BY channel_id")
      .all() as Array<{ channel_id: string; profile_id: string }>;
    return rows.map((r) => ({ channelId: r.channel_id, profileId: r.profile_id }));
  }

  // ── Profile Settings (key-value) ──────────────────────────────

  setProfileSetting(profileId: string, key: string, value: string | null): void {
    this.db
      .prepare(
        `INSERT INTO profile_settings (profile_id, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(profileId, key, value);
  }

  getProfileSetting(profileId: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?")
      .get(profileId, key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
