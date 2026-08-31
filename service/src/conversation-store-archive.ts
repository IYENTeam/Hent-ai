import type { ServiceDatabase } from "./db.js";
import { rawEventFromRow, requireRowRecord } from "./conversation-store-rows.js";
import type { ConversationRawEvent } from "./conversation-store-types.js";

export type PersistedArchiveBatch = {
  readonly batchKey: string;
  readonly summaryKey: string;
  readonly scopeId: string;
  readonly sourceStartId: number;
  readonly sourceEndId: number;
  readonly sourceEventIds: readonly number[];
};

export function listClaimableArchiveBatches(db: ServiceDatabase, now: number): readonly PersistedArchiveBatch[] {
  return db.db.prepare(`SELECT batch_key,summary_key,scope_id,source_start_id,source_end_id,source_event_ids_json
    FROM conversation_archive_batches WHERE status='pending' OR (status='retryable' AND next_attempt_at_ms<=?)
    OR (status='claimed' AND claim_expires_at_ms<=?) ORDER BY created_at_ms,batch_key`).all(now, now)
    .flatMap((row) => batchFromRow(requireRowRecord(row, "conversation_archive_batches")));
}

export function loadArchiveBatchEvents(db: ServiceDatabase, batch: PersistedArchiveBatch): readonly ConversationRawEvent[] {
  return db.db.prepare(`SELECT r.* FROM json_each(?) source JOIN conversation_raw_events r ON r.id=CAST(source.value AS INTEGER)
    ORDER BY CAST(source.key AS INTEGER)`).all(JSON.stringify(batch.sourceEventIds))
    .map((row) => rawEventFromRow(requireRowRecord(row, "conversation_raw_events")));
}

function batchFromRow(row: Readonly<Record<string, unknown>>): readonly PersistedArchiveBatch[] {
  const sourceEventIds = parseSourceIds(row.source_event_ids_json);
  if (!sourceEventIds) return [];
  return [{ batchKey: stringAt(row, "batch_key"), summaryKey: stringAt(row, "summary_key"), scopeId: stringAt(row, "scope_id"),
    sourceStartId: numberAt(row, "source_start_id"), sourceEndId: numberAt(row, "source_end_id"), sourceEventIds }];
}

function parseSourceIds(value: unknown): readonly number[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((id) => !Number.isSafeInteger(id) || id <= 0)) return null;
    const ids = parsed as number[];
    return new Set(ids).size === ids.length ? ids : null;
  } catch { return null; }
}

function stringAt(row: Readonly<Record<string, unknown>>, key: string): string {
  if (typeof row[key] !== "string") throw new TypeError(`Expected ${key}`);
  return row[key];
}

function numberAt(row: Readonly<Record<string, unknown>>, key: string): number {
  if (typeof row[key] !== "number") throw new TypeError(`Expected ${key}`);
  return row[key];
}
