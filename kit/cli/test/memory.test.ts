import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportMemory } from "../src/memory.ts";

// Exact statements from service/src/db-schema-adaptive.ts.
const DDL = [
  `CREATE TABLE IF NOT EXISTS conversation_archive_batches (batch_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL, source_start_id INTEGER NOT NULL, source_end_id INTEGER NOT NULL, source_event_ids_json TEXT NOT NULL DEFAULT '[]', summary_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, claim_holder_id TEXT, claim_fence_token INTEGER, claim_expires_at_ms INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, provider_diagnostic TEXT, next_attempt_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS conversation_archive_summaries (summary_key TEXT PRIMARY KEY, batch_key TEXT NOT NULL UNIQUE REFERENCES conversation_archive_batches(batch_key), summary TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS adaptive_relationship_profiles (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL, rapport REAL NOT NULL DEFAULT 0.5, familiarity REAL NOT NULL DEFAULT 0.5, notes_json TEXT NOT NULL DEFAULT '[]', updated_at_ms INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id));`,
];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "hent-memory-")); dirs.push(d); return d; };
const mode = (p: string) => statSync(p).mode & 0o777;

function seed(path: string): void {
  const db = new Database(path);
  for (const sql of DDL) db.run(sql);
  db.run("INSERT INTO conversation_archive_batches (batch_key,scope_id,source_start_id,source_end_id,summary_key,status,created_at_ms,updated_at_ms) VALUES ('b1','discord:g1:c1',1,5,'s1','completed',1000,1000)");
  db.run("INSERT INTO conversation_archive_summaries (summary_key,batch_key,summary,created_at_ms) VALUES ('s1','b1','They planned the release.',2000)");
  db.run("INSERT INTO adaptive_relationship_profiles (guild_id,channel_id,user_id,rapport,familiarity,notes_json,updated_at_ms) VALUES ('g1','c1','u1',0.7,0.6,'[\"likes terse replies\"]',3000)");
  db.close();
}

test("exports channel and person files read-only with private modes", () => {
  const root = tmp();
  const dbPath = join(root, "svc.db");
  seed(dbPath);
  const out = join(root, "out");
  expect(exportMemory({ dbPath, outDir: out })).toEqual({ channels: 1, people: 1 });
  const channel = join(out, "channels", "c1.md");
  const person = join(out, "people", "u1.md");
  expect(readFileSync(channel, "utf8")).toContain("They planned the release.");
  const p = readFileSync(person, "utf8");
  expect(p).toContain("rapport: 0.7");
  expect(p).toContain("familiarity: 0.6");
  expect(p).toContain("- likes terse replies");
  expect(mode(channel)).toBe(0o600);
  expect(mode(person)).toBe(0o600);
  expect(mode(join(out, "channels"))).toBe(0o700);
  expect(mode(join(out, "people"))).toBe(0o700);
  const ro = new Database(dbPath, { readonly: true });
  expect(() => ro.run("DELETE FROM adaptive_relationship_profiles")).toThrow();
  ro.close();
});

test("nonexistent db throws a clear error and writes nothing", () => {
  const root = tmp();
  const out = join(root, "out");
  expect(() => exportMemory({ dbPath: join(root, "missing.db"), outDir: out })).toThrow(/database not found/);
  expect(existsSync(out)).toBe(false);
});
