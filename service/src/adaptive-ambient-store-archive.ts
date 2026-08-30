import type Database from "better-sqlite3";
import type { Fence } from "./adaptive-ambient-store.js";

type ArchiveInput = { readonly batchKey: string; readonly summaryKey: string; readonly scopeId: string; readonly sourceStartId: number; readonly sourceEndId: number; readonly sourceEventIds?: readonly number[]; readonly fence: Fence };

export function claimArchiveBatch(db: Database.Database, now: number, input: ArchiveInput): boolean {
  db.prepare(`INSERT OR IGNORE INTO conversation_archive_batches (batch_key,scope_id,source_start_id,source_end_id,source_event_ids_json,summary_key,status,created_at_ms,updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(input.batchKey, input.scopeId, input.sourceStartId, input.sourceEndId, JSON.stringify(input.sourceEventIds ?? []), input.summaryKey, now, now);
  return db.prepare(`UPDATE conversation_archive_batches SET status='claimed',claim_holder_id=?,claim_fence_token=?,claim_expires_at_ms=?,attempt_count=attempt_count+1,updated_at_ms=?
    WHERE batch_key=? AND (status='pending' OR (status='retryable' AND next_attempt_at_ms<=?) OR (status='claimed' AND claim_expires_at_ms<=?)) AND ${fencedWhere()}`)
    .run(input.fence.holderId, input.fence.fenceToken, now + 120_000, now, input.batchKey, now, now, ...fencedArgs(input.fence, now)).changes === 1;
}

export function retryArchiveBatch(db: Database.Database, now: number, batchKey: string, fence: Fence): boolean {
  return db.prepare(`UPDATE conversation_archive_batches SET status='retryable',provider_diagnostic='provider_compaction_failed',next_attempt_at_ms=?,updated_at_ms=? WHERE batch_key=? AND status='claimed'
    AND claim_holder_id=? AND claim_fence_token=? AND claim_expires_at_ms>? AND ${fencedWhere()}`)
    .run(now + 120_000, now, batchKey, fence.holderId, fence.fenceToken, now, ...fencedArgs(fence, now)).changes === 1;
}

export function completeArchiveBatch(db: Database.Database, now: number, batchKey: string, summary: string, fence: Fence, rawEventIds: readonly number[]): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const batch = db.prepare(`SELECT summary_key FROM conversation_archive_batches WHERE batch_key=? AND status='claimed' AND claim_holder_id=?
      AND claim_fence_token=? AND claim_expires_at_ms>? AND ${fencedWhere()}`).get(batchKey, fence.holderId, fence.fenceToken, now, ...fencedArgs(fence, now)) as { summary_key: string } | undefined;
    if (!batch) { db.exec("ROLLBACK"); return false; }
    db.prepare("INSERT OR IGNORE INTO conversation_archive_summaries (summary_key,batch_key,summary,created_at_ms) VALUES (?, ?, ?, ?)").run(batch.summary_key, batchKey, summary, now);
    for (const rawEventId of rawEventIds) {
      db.prepare("INSERT OR IGNORE INTO conversation_raw_archive_markers (raw_event_id,batch_key,archived_at_ms) VALUES (?, ?, ?)").run(rawEventId, batchKey, now);
      db.prepare("UPDATE conversation_raw_events SET archived_at_ms=? WHERE id=? AND archived_at_ms IS NULL").run(now, rawEventId);
    }
    const completed = db.prepare(`UPDATE conversation_archive_batches SET status='completed',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,
      provider_diagnostic=NULL,next_attempt_at_ms=NULL,updated_at_ms=? WHERE batch_key=? AND claim_holder_id=? AND claim_fence_token=?
      AND claim_expires_at_ms>? AND ${fencedWhere()}`).run(now, batchKey, fence.holderId, fence.fenceToken, now, ...fencedArgs(fence, now));
    if (completed.changes !== 1) { db.exec("ROLLBACK"); return false; }
    db.exec("COMMIT"); return true;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function markRawArchived(db: Database.Database, now: number, rawEventId: number, batchKey: string, fence: Fence): boolean {
  return db.prepare(`INSERT OR IGNORE INTO conversation_raw_archive_markers (raw_event_id,batch_key,archived_at_ms)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM conversation_archive_batches WHERE batch_key=? AND status='claimed'
      AND claim_holder_id=? AND claim_fence_token=? AND claim_expires_at_ms>?) AND ${fencedWhere()}`)
    .run(rawEventId, batchKey, now, batchKey, fence.holderId, fence.fenceToken, now, ...fencedArgs(fence, now)).changes === 1;
}

function fencedWhere(): string { return "EXISTS (SELECT 1 FROM adaptive_leases l WHERE l.lease_key=? AND l.holder_id=? AND l.fence_token=? AND l.expires_at_ms>?)"; }
function fencedArgs(fence: Fence, now: number): [string, string, number, number] { return [fence.key, fence.holderId, fence.fenceToken, now]; }
