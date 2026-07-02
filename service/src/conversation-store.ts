import type { ServiceDatabase } from "./db.js";
import {
  checkpointFromRow,
  rawEventFromRow,
  requireRowRecord,
  summaryFromRow,
} from "./conversation-store-rows.js";
import type {
  ConversationCheckpoint,
  ConversationCheckpointInput,
  ConversationRawEvent,
  ConversationRawEventInput,
  ConversationSummary,
  ConversationSummaryInput,
  RawRetentionInput,
} from "./conversation-store-types.js";

export type {
  ConversationAuthorRole,
  ConversationCheckpoint,
  ConversationCheckpointInput,
  ConversationRawEvent,
  ConversationRawEventInput,
  ConversationSummary,
  ConversationSummaryInput,
  RawRetentionInput,
} from "./conversation-store-types.js";

export class ConversationStore {
  constructor(private readonly serviceDb: ServiceDatabase) {}

  recordRawEvent(input: ConversationRawEventInput): ConversationRawEvent {
    const observedAt = input.observedAt ?? new Date().toISOString();
    this.serviceDb.db.prepare(`INSERT INTO conversation_raw_events
      (scope_id, channel_id, thread_id, session_id, message_id, author_role, author_source, text, event_ts, observed_at, bot_self_loop, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, message_id, author_source) DO UPDATE SET
        channel_id = excluded.channel_id,
        thread_id = excluded.thread_id,
        session_id = excluded.session_id,
        author_role = excluded.author_role,
        text = excluded.text,
        event_ts = excluded.event_ts,
        observed_at = excluded.observed_at,
        bot_self_loop = excluded.bot_self_loop,
        metadata_json = excluded.metadata_json`)
      .run(
        input.scopeId,
        input.channelId,
        input.threadId ?? null,
        input.sessionId ?? null,
        input.messageId,
        input.authorRole,
        input.authorSource,
        input.text,
        input.eventTs,
        observedAt,
        input.botSelfLoop === true ? 1 : 0,
        JSON.stringify(input.metadata ?? {}),
        observedAt,
      );
    const row = this.serviceDb.db.prepare("SELECT * FROM conversation_raw_events WHERE scope_id = ? AND message_id = ? AND author_source = ?")
      .get(input.scopeId, input.messageId, input.authorSource);
    return rawEventFromRow(requireRowRecord(row, "conversation_raw_events"));
  }

  listRawEvents(scopeId: string): ConversationRawEvent[] {
    return this.serviceDb.db.prepare("SELECT * FROM conversation_raw_events WHERE scope_id = ? ORDER BY event_ts, id")
      .all(scopeId)
      .map((row) => rawEventFromRow(requireRowRecord(row, "conversation_raw_events")));
  }

  listRawEventScopeIdsBefore(cutoff: string): string[] {
    return this.serviceDb.db.prepare<[string], { scope_id: string }>(
      "SELECT DISTINCT scope_id FROM conversation_raw_events WHERE event_ts < ? ORDER BY scope_id",
    ).all(cutoff).map((row) => row.scope_id);
  }

  deleteRawEventsByIds(ids: readonly number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    return this.serviceDb.db.prepare(`DELETE FROM conversation_raw_events WHERE id IN (${placeholders})`).run(...ids).changes;
  }

  upsertCheckpoint(input: ConversationCheckpointInput): ConversationCheckpoint {
    this.serviceDb.db.prepare(`INSERT INTO conversation_checkpoints (scope_id, channel_id, summary, recent_event_ids_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        summary = excluded.summary,
        recent_event_ids_json = excluded.recent_event_ids_json,
        updated_at = excluded.updated_at`)
      .run(input.scopeId, input.channelId, input.summary, JSON.stringify(input.recentEventIds), input.updatedAt);
    return this.getCheckpoint(input.scopeId) ?? input;
  }

  getCheckpoint(scopeId: string): ConversationCheckpoint | null {
    const row = this.serviceDb.db.prepare("SELECT * FROM conversation_checkpoints WHERE scope_id = ?").get(scopeId);
    return row ? checkpointFromRow(requireRowRecord(row, "conversation_checkpoints")) : null;
  }

  addSummary(input: ConversationSummaryInput): ConversationSummary {
    const result = this.serviceDb.db.prepare(`INSERT INTO conversation_summaries
      (scope_id, channel_id, summary, source_event_start_id, source_event_end_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.scopeId, input.channelId, input.summary, input.sourceEventStartId, input.sourceEventEndId, input.createdAt);
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  listSummaries(scopeId: string): ConversationSummary[] {
    return this.serviceDb.db.prepare("SELECT * FROM conversation_summaries WHERE scope_id = ? ORDER BY id")
      .all(scopeId)
      .map((row) => summaryFromRow(requireRowRecord(row, "conversation_summaries")));
  }

  pruneRawEvents(input: RawRetentionInput): number {
    const cutoff = new Date(new Date(input.now).getTime() - input.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.serviceDb.db.prepare("DELETE FROM conversation_raw_events WHERE event_ts < ?").run(cutoff).changes;
  }
}

export function createConversationStore(db: ServiceDatabase): ConversationStore {
  return new ConversationStore(db);
}
