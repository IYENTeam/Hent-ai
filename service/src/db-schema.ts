import type Database from "better-sqlite3";
import { ADAPTIVE_SCHEMA_SQL } from "./db-schema-adaptive.js";

export const SCHEMA_VERSION = 7;

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
`;

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return db.prepare<[], { readonly name: string }>(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}
function participationStatusMigrationRequired(db: Database.Database): boolean {
  const sql = db.prepare<[], { readonly sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_participation_ticks'").get()?.sql;
  return sql?.includes("'corrupt'") ?? false;
}

function migrateParticipationStatuses(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE conversation_participation_ticks_v7 (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('apply','shadow')), primary_contract_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('bound','budget_wait','primary_claimed','primary_retry_wait','primary_invalid','primary_unavailable','context_truncated','snapshot_corrupt','decided','validation_claimed','validated','validation_unavailable','aborted')),
        anchor_work_id TEXT NOT NULL REFERENCES participant_event_work(id), snapshot_high_watermark_id INTEGER NOT NULL REFERENCES conversation_raw_events(id),
        snapshot_json TEXT NOT NULL, snapshot_utf8_bytes INTEGER NOT NULL CHECK(snapshot_utf8_bytes BETWEEN 2 AND 49152), snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest)=64),
        persona_source TEXT NOT NULL CHECK(persona_source IN ('channel_profile','configured_global','generic')), persona_text TEXT NOT NULL, persona_utf8_bytes INTEGER NOT NULL CHECK(persona_utf8_bytes BETWEEN 1 AND 8192), persona_digest TEXT NOT NULL CHECK(length(persona_digest)=64), persona_revision TEXT NOT NULL CHECK(length(persona_revision)=64),
        primary_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(primary_attempt_count BETWEEN 0 AND 3), primary_claim_holder_id TEXT, primary_claim_fence_token INTEGER, primary_claim_expires_at_ms INTEGER,
        primary_result_json TEXT, primary_result_utf8_bytes INTEGER, primary_result_digest TEXT, delivery_disposition TEXT CHECK(delivery_disposition IN ('pending','delivered','retryable','cancelled','not_applicable')), abort_reason TEXT CHECK(abort_reason IN ('scope_fence_lost','explicit_predecision')),
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        CHECK ((status='primary_claimed') = (primary_claim_holder_id IS NOT NULL AND primary_claim_fence_token IS NOT NULL AND primary_claim_expires_at_ms IS NOT NULL)),
        CHECK (status='primary_claimed' OR (primary_claim_holder_id IS NULL AND primary_claim_fence_token IS NULL AND primary_claim_expires_at_ms IS NULL)),
        CHECK ((primary_result_json IS NULL AND primary_result_utf8_bytes IS NULL AND primary_result_digest IS NULL) OR (primary_result_json IS NOT NULL AND primary_result_utf8_bytes BETWEEN 1 AND 9216 AND primary_result_digest IS NOT NULL AND length(primary_result_digest)=64))
      );
      INSERT INTO conversation_participation_ticks_v7 SELECT
        id,guild_id,channel_id,mode,primary_contract_version,
        CASE status WHEN 'corrupt' THEN 'snapshot_corrupt' ELSE status END,
        anchor_work_id,snapshot_high_watermark_id,snapshot_json,snapshot_utf8_bytes,snapshot_digest,persona_source,persona_text,persona_utf8_bytes,persona_digest,persona_revision,primary_attempt_count,primary_claim_holder_id,primary_claim_fence_token,primary_claim_expires_at_ms,primary_result_json,primary_result_utf8_bytes,primary_result_digest,delivery_disposition,abort_reason,created_at_ms,updated_at_ms
      FROM conversation_participation_ticks;
      CREATE TABLE conversation_participation_validations_v7 (
        tick_id TEXT PRIMARY KEY REFERENCES conversation_participation_ticks_v7(id), status TEXT NOT NULL CHECK(status IN ('pending','claimed','applied','accepted_shadow','unavailable')), schema_version TEXT NOT NULL, model TEXT NOT NULL, claim_holder_id TEXT, claim_fence_token INTEGER, claim_expires_at_ms INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3), missed_opportunity REAL CHECK(missed_opportunity BETWEEN 0 AND 1), interruption REAL CHECK(interruption BETWEEN 0 AND 1), confidence REAL CHECK(confidence BETWEEN 0 AND 1), prior_delta REAL CHECK(prior_delta BETWEEN -0.05 AND 0.05), rationale TEXT, rationale_utf8_bytes INTEGER CHECK(rationale_utf8_bytes BETWEEN 1 AND 2000), prior_before REAL CHECK(prior_before BETWEEN -0.25 AND 0.25), prior_after REAL CHECK(prior_after BETWEEN -0.25 AND 0.25), prior_version_before INTEGER, prior_version_after INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        CHECK ((status='claimed') = (claim_holder_id IS NOT NULL AND claim_fence_token IS NOT NULL AND claim_expires_at_ms IS NOT NULL)),
        CHECK (status='claimed' OR (claim_holder_id IS NULL AND claim_fence_token IS NULL AND claim_expires_at_ms IS NULL)),
        CHECK ((status IN ('pending','claimed','unavailable') AND missed_opportunity IS NULL AND interruption IS NULL AND confidence IS NULL AND prior_delta IS NULL AND rationale IS NULL AND rationale_utf8_bytes IS NULL AND prior_before IS NULL AND prior_after IS NULL AND prior_version_before IS NULL AND prior_version_after IS NULL) OR (status='applied' AND missed_opportunity IS NOT NULL AND interruption IS NOT NULL AND confidence IS NOT NULL AND prior_delta IS NOT NULL AND rationale IS NOT NULL AND rationale_utf8_bytes IS NOT NULL AND prior_before IS NOT NULL AND prior_after IS NOT NULL AND prior_version_before IS NOT NULL AND prior_version_after IS NOT NULL) OR (status='accepted_shadow' AND missed_opportunity IS NOT NULL AND interruption IS NOT NULL AND confidence IS NOT NULL AND prior_delta IS NOT NULL AND rationale IS NOT NULL AND rationale_utf8_bytes IS NOT NULL AND prior_before IS NULL AND prior_after IS NULL AND prior_version_before IS NULL AND prior_version_after IS NULL))
      );
      INSERT INTO conversation_participation_validations_v7 SELECT
        tick_id,CASE status WHEN 'corrupt' THEN 'unavailable' ELSE status END,schema_version,model,claim_holder_id,claim_fence_token,claim_expires_at_ms,attempt_count,missed_opportunity,interruption,confidence,prior_delta,rationale,rationale_utf8_bytes,prior_before,prior_after,prior_version_before,prior_version_after,created_at_ms,updated_at_ms
      FROM conversation_participation_validations;
      DROP TABLE conversation_participation_validations;
      DROP TABLE conversation_participation_ticks;
      ALTER TABLE conversation_participation_ticks_v7 RENAME TO conversation_participation_ticks;
      ALTER TABLE conversation_participation_validations_v7 RENAME TO conversation_participation_validations;
      CREATE UNIQUE INDEX uq_participation_tick_apply_anchor ON conversation_participation_ticks(anchor_work_id) WHERE mode='apply' AND status <> 'aborted';
      CREATE INDEX idx_participation_ticks_scope_status ON conversation_participation_ticks(guild_id,channel_id,mode,status,created_at_ms,id);
      CREATE INDEX idx_participation_validation_status ON conversation_participation_validations(status,created_at_ms,tick_id);
      COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function initializeServiceSchema(db: Database.Database, appliedAt: string): void {
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(ADAPTIVE_SCHEMA_SQL);
  if (!columnExists(db, "conversation_raw_events", "archived_at_ms")) {
    db.exec("ALTER TABLE conversation_raw_events ADD COLUMN archived_at_ms INTEGER");
  }
  if (!columnExists(db, "channel_settings", "cron_enabled")) {
    db.exec("ALTER TABLE channel_settings ADD COLUMN cron_enabled INTEGER CHECK (cron_enabled IN (0, 1))");
  }
  if (participationStatusMigrationRequired(db)) migrateParticipationStatuses(db);
  for (const migration of [
    ["conversation_archive_batches", "source_event_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["conversation_archive_batches", "provider_diagnostic", "TEXT"],
    ["conversation_archive_batches", "next_attempt_at_ms", "INTEGER"],
    ["adaptive_ambient_audits", "evidence_weight", "REAL"],
    ["adaptive_ambient_audits", "probability", "REAL"],
    ["adaptive_ambient_audits", "draw", "REAL"],
    ["adaptive_ambient_audits", "drive_before", "REAL"],
    ["adaptive_ambient_audits", "drive_after", "REAL"],
    ["adaptive_ambient_audits", "active_human_count", "INTEGER"],
    ["adaptive_ambient_audits", "roster_fresh", "INTEGER"],
    ["adaptive_relationship_profiles", "channel_id", "TEXT NOT NULL DEFAULT ''"],
    ["adaptive_relationship_ledger", "channel_id", "TEXT NOT NULL DEFAULT ''"],
    ["adaptive_ambient_state", "pressure", "REAL NOT NULL DEFAULT 0"],
    ["adaptive_ambient_state", "pressure_updated_at_ms", "INTEGER"],
    ["adaptive_ambient_state", "speak_streak", "INTEGER NOT NULL DEFAULT 0"],
    ["adaptive_ambient_state", "skip_streak", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!columnExists(db, migration[0], migration[1])) db.exec(`ALTER TABLE ${migration[0]} ADD COLUMN ${migration[1]} ${migration[2]}`);
  }
  for (const migration of [
    ["participant_event_work", "participation_tick_id", "TEXT REFERENCES conversation_participation_ticks(id)"],
    ["participant_delivery_plans", "decision_version", "TEXT NOT NULL DEFAULT 'v1' CHECK(decision_version IN ('v1','v2'))"],
    ["participant_delivery_plans", "tick_id", "TEXT REFERENCES conversation_participation_ticks(id)"],
  ] as const) {
    if (!columnExists(db, migration[0], migration[1])) db.exec(`ALTER TABLE ${migration[0]} ADD COLUMN ${migration[1]} ${migration[2]}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_participant_work_generic_claim ON participant_event_work(guild_id,channel_id,status,created_at_ms,id) WHERE participation_tick_id IS NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_adaptive_relationship_profiles_guild_channel_user ON adaptive_relationship_profiles(guild_id, channel_id, user_id)");
  const existingVersion = db.prepare<[], { readonly version: number }>("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0;
  if (existingVersion < SCHEMA_VERSION) {
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(SCHEMA_VERSION, appliedAt);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
