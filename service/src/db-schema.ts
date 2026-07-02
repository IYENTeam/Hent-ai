import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  character TEXT,
  soul_snippet TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_mappings (
  channel_id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  mode TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id TEXT PRIMARY KEY,
  enabled INTEGER CHECK (enabled IN (0, 1)),
  cron_enabled INTEGER CHECK (cron_enabled IN (0, 1)),
  asset_set_id TEXT,
  settings_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  character TEXT,
  model TEXT,
  manifest_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_key TEXT NOT NULL UNIQUE,
  object_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  local_path TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  asset_set_id TEXT NOT NULL REFERENCES asset_sets(id) ON DELETE CASCADE,
  emotion TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_object_id INTEGER NOT NULL REFERENCES storage_objects(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(asset_set_id, emotion, filename)
);

CREATE TABLE IF NOT EXISTS emotion_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  asset_set_id TEXT REFERENCES asset_sets(id) ON DELETE CASCADE,
  emotion TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, asset_set_id, emotion)
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifier_cache (
  cache_key TEXT PRIMARY KEY,
  verdict_json TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  session_id TEXT,
  message_id TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('user', 'assistant', 'system')),
  author_source TEXT NOT NULL,
  text TEXT NOT NULL,
  event_ts TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  bot_self_loop INTEGER NOT NULL CHECK (bot_self_loop IN (0, 1)),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scope_id, message_id, author_source)
);

CREATE INDEX IF NOT EXISTS idx_conversation_raw_events_scope_ts ON conversation_raw_events(scope_id, event_ts, id);
CREATE INDEX IF NOT EXISTS idx_conversation_raw_events_event_ts ON conversation_raw_events(event_ts);

CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  scope_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  recent_event_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_event_start_id INTEGER NOT NULL,
  source_event_end_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_scope ON conversation_summaries(scope_id, id);

CREATE TABLE IF NOT EXISTS conversation_delivery_ledger (
  plan_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  cooldown_key TEXT NOT NULL,
  required_chunk_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'committed')),
  delivery_message_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversation_delivery_scope ON conversation_delivery_ledger(scope_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_gate_state (
  scope_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  cooldown_until TEXT,
  budget_window_start TEXT,
  budget_count INTEGER NOT NULL,
  last_signal_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope_id, state_key)
);

CREATE TABLE IF NOT EXISTS discord_poller_state (
  channel_id TEXT PRIMARY KEY,
  last_seen_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return db.prepare<[], { readonly name: string }>(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

export function initializeServiceSchema(db: Database.Database, appliedAt: string): void {
  db.exec(SCHEMA_SQL);
  if (!columnExists(db, "channel_settings", "cron_enabled")) {
    db.exec("ALTER TABLE channel_settings ADD COLUMN cron_enabled INTEGER CHECK (cron_enabled IN (0, 1))");
  }
  const existingVersion = db.prepare<[], { readonly version: number }>("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0;
  if (existingVersion < SCHEMA_VERSION) {
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(SCHEMA_VERSION, appliedAt);
  }
}
