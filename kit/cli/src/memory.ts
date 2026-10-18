import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_SUMMARIES = 20;

export type MemoryExportResult = { readonly channels: number; readonly people: number };

type SummaryRow = { scope_id: string; summary: string; created_at_ms: number };
type ProfileRow = { guild_id: string; channel_id: string; user_id: string; rapport: number; familiarity: number; notes_json: string; updated_at_ms: number };

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_") || "_";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseNotes(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function writePrivate(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, name);
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function exportMemory(opts: { dbPath: string; outDir: string }): MemoryExportResult {
  if (!existsSync(opts.dbPath)) throw new Error(`memory export: database not found: ${opts.dbPath}`);
  let db: Database;
  try {
    db = new Database(opts.dbPath, { readonly: true });
  } catch (error) {
    throw new Error(`memory export: cannot open database read-only: ${opts.dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let summaries: SummaryRow[];
  let profiles: ProfileRow[];
  try {
    summaries = db.query(`SELECT b.scope_id AS scope_id, s.summary AS summary, s.created_at_ms AS created_at_ms
      FROM conversation_archive_summaries s JOIN conversation_archive_batches b ON b.batch_key=s.batch_key
      WHERE b.status='completed' ORDER BY s.created_at_ms DESC`).all() as SummaryRow[];
    profiles = db.query("SELECT guild_id, channel_id, user_id, rapport, familiarity, notes_json, updated_at_ms FROM adaptive_relationship_profiles ORDER BY user_id").all() as ProfileRow[];
  } catch (error) {
    throw new Error(`memory export: unexpected database schema: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }

  const byChannel = new Map<string, SummaryRow[]>();
  for (const row of summaries) {
    const channelId = row.scope_id.split(":").at(-1) ?? row.scope_id;
    const list = byChannel.get(channelId) ?? [];
    if (list.length < MAX_SUMMARIES) list.push(row);
    byChannel.set(channelId, list);
  }
  for (const [channelId, rows] of byChannel) {
    const body = [`# Channel ${channelId}`, "", "Latest conversation summaries, newest first.", "",
      ...rows.flatMap((r) => [`## ${iso(r.created_at_ms)}`, "", r.summary.trim(), ""])].join("\n");
    writePrivate(join(opts.outDir, "channels"), `${safeName(channelId)}.md`, body);
  }

  const byUser = new Map<string, ProfileRow>();
  for (const p of profiles) {
    const prev = byUser.get(p.user_id);
    if (!prev || p.updated_at_ms > prev.updated_at_ms) byUser.set(p.user_id, p);
  }
  for (const [userId, p] of byUser) {
    const notes = parseNotes(p.notes_json);
    const body = [`# Person ${userId}`, "",
      `- rapport: ${p.rapport}`, `- familiarity: ${p.familiarity}`, `- updated: ${iso(p.updated_at_ms)}`, "",
      "## Notes", "", ...(notes.length ? notes.map((n) => `- ${n}`) : ["- (none)"]), ""].join("\n");
    writePrivate(join(opts.outDir, "people"), `${safeName(userId)}.md`, body);
  }
  return { channels: byChannel.size, people: byUser.size };
}
