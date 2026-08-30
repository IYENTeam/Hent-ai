import type { ServiceDatabase } from "./db.js";
import { listClaimableArchiveBatches, loadArchiveBatchEvents, type PersistedArchiveBatch } from "./conversation-store-archive.js";
import {
  checkpointFromRow,
  deliveryPlanFromRow,
  gateStateFromRow,
  rawEventFromRow,
  requireRowRecord,
  sameStringRecord,
  summaryFromRow,
} from "./conversation-store-rows.js";
import type {
  CommitDeliveryInput,
  CommitDeliveryResult,
  ConversationCheckpoint,
  ConversationCheckpointInput,
  ConversationGateState,
  ConversationRawEvent,
  ConversationRawEventInput,
  ConversationSummary,
  ConversationSummaryInput,
  DeliveryPlan,
  DeliveryPlanInput,
} from "./conversation-store-types.js";

export type {
  CommitDeliveryInput,
  CommitDeliveryResult,
  ConversationAuthorRole,
  ConversationCheckpoint,
  ConversationCheckpointInput,
  ConversationGateState,
  ConversationRawEvent,
  ConversationRawEventInput,
  ConversationSummary,
  ConversationSummaryInput,
  DeliveryPlan,
  DeliveryPlanInput,
} from "./conversation-store-types.js";

export type ConversationArchiveCandidateGroup = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly sessionId: string | null;
  readonly events: readonly ConversationRawEvent[];
};

export type ConversationArchivedSummary = {
  readonly summaryKey: string;
  readonly batchKey: string;
  readonly summary: string;
  readonly createdAtMs: number;
};

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

  listActiveRawEvents(scopeId: string): ConversationRawEvent[] {
    return this.serviceDb.db.prepare("SELECT * FROM conversation_raw_events WHERE scope_id = ? AND archived_at_ms IS NULL ORDER BY event_ts, id")
      .all(scopeId)
      .map((row) => rawEventFromRow(requireRowRecord(row, "conversation_raw_events")));
  }

  listArchiveCandidateGroups(cutoff: string): ConversationArchiveCandidateGroup[] {
    const rows = this.serviceDb.db.prepare(`SELECT * FROM conversation_raw_events r WHERE event_ts < ? AND archived_at_ms IS NULL
      AND NOT EXISTS (SELECT 1 FROM conversation_summaries s WHERE s.scope_id=r.scope_id AND r.id BETWEEN s.source_event_start_id AND s.source_event_end_id)
      AND NOT EXISTS (SELECT 1 FROM conversation_archive_batches b JOIN json_each(b.source_event_ids_json) source
        WHERE b.status <> 'completed' AND CAST(source.value AS INTEGER)=r.id)
      ORDER BY scope_id, event_ts, id`)
      .all(cutoff)
      .map((row) => rawEventFromRow(requireRowRecord(row, "conversation_raw_events")));
    const grouped = new Map<string, ConversationRawEvent[]>();
    for (const event of rows) {
      const events = grouped.get(event.scopeId) ?? [];
      events.push(event);
      grouped.set(event.scopeId, events);
    }
    return [...grouped.entries()].map(([scopeId, events]) => {
      const first = events[0];
      if (!first) throw new Error("archive group must contain an event");
      return { scopeId, channelId: first.channelId, threadId: first.threadId, sessionId: first.sessionId, events };
    });
  }

  listClaimableArchiveBatches(now: number): readonly PersistedArchiveBatch[] { return listClaimableArchiveBatches(this.serviceDb, now); }

  loadArchiveBatchEvents(batch: PersistedArchiveBatch): readonly ConversationRawEvent[] { return loadArchiveBatchEvents(this.serviceDb, batch); }

  listArchivedSummaries(scopeId: string): ConversationArchivedSummary[] {
    return this.serviceDb.db.prepare(`SELECT s.summary_key, s.batch_key, s.summary, s.created_at_ms
      FROM conversation_archive_summaries s JOIN conversation_archive_batches b ON b.batch_key=s.batch_key
      WHERE b.scope_id=? AND b.status='completed' ORDER BY s.created_at_ms, s.summary_key`).all(scopeId)
      .map((row) => {
        const record = requireRowRecord(row, "conversation_archive_summaries");
        return { summaryKey: String(record.summary_key), batchKey: String(record.batch_key), summary: String(record.summary), createdAtMs: Number(record.created_at_ms) };
      });
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

  createDeliveryPlan(input: DeliveryPlanInput): DeliveryPlan {
    this.serviceDb.db.prepare(`INSERT INTO conversation_delivery_ledger
      (plan_id, scope_id, channel_id, signal_id, cooldown_key, required_chunk_ids_json, status, delivery_message_ids_json, created_at, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'planned', '{}', ?, NULL)`)
      .run(input.planId, input.scopeId, input.channelId, input.signalId, input.cooldownKey, JSON.stringify(input.requiredChunkIds), input.createdAt);
    const plan = this.getDeliveryPlan(input.planId);
    if (!plan) throw new Error("Delivery plan was not created");
    return plan;
  }

  getDeliveryPlan(planId: string): DeliveryPlan | null {
    const row = this.serviceDb.db.prepare("SELECT * FROM conversation_delivery_ledger WHERE plan_id = ?").get(planId);
    return row ? deliveryPlanFromRow(requireRowRecord(row, "conversation_delivery_ledger")) : null;
  }

  commitDelivery(input: CommitDeliveryInput): CommitDeliveryResult {
    const plan = this.getDeliveryPlan(input.planId);
    if (!plan) throw new Error("Delivery plan not found");
    if (plan.status === "committed") {
      return sameStringRecord(plan.deliveryMessageIds, input.deliveryMessageIds)
        ? { status: "idempotent", plan }
        : { status: "conflict", plan };
    }
    const missingChunkIds = plan.requiredChunkIds.filter((chunkId) => !input.deliveryMessageIds[chunkId]);
    if (missingChunkIds.length > 0) return { status: "missing_required_chunks", missingChunkIds };
    this.commitPlannedDelivery(plan, input);
    const committed = this.getDeliveryPlan(input.planId);
    if (!committed) throw new Error("Committed delivery plan not found");
    return { status: "committed", plan: committed };
  }

  getGateState(scopeId: string, stateKey: string): ConversationGateState | null {
    const row = this.serviceDb.db.prepare("SELECT * FROM conversation_gate_state WHERE scope_id = ? AND state_key = ?")
      .get(scopeId, stateKey);
    return row ? gateStateFromRow(requireRowRecord(row, "conversation_gate_state")) : null;
  }

  private commitPlannedDelivery(plan: DeliveryPlan, input: CommitDeliveryInput): void {
    const transaction = this.serviceDb.db.transaction(() => {
      this.serviceDb.db.prepare(`UPDATE conversation_delivery_ledger
        SET status = 'committed', delivery_message_ids_json = ?, committed_at = ?
        WHERE plan_id = ? AND status = 'planned'`)
        .run(JSON.stringify(input.deliveryMessageIds), input.committedAt, input.planId);
      this.serviceDb.db.prepare(`INSERT INTO conversation_gate_state
        (scope_id, state_key, cooldown_until, budget_window_start, budget_count, last_signal_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, state_key) DO UPDATE SET
          cooldown_until = excluded.cooldown_until,
          budget_window_start = excluded.budget_window_start,
          budget_count = excluded.budget_count,
          last_signal_id = excluded.last_signal_id,
          updated_at = excluded.updated_at`)
        .run(plan.scopeId, plan.cooldownKey, input.cooldownUntil ?? null, input.budgetWindowStart ?? null, input.budgetCount ?? 0, plan.signalId, input.committedAt);
    });
    transaction();
  }
}

export function createConversationStore(db: ServiceDatabase): ConversationStore {
  return new ConversationStore(db);
}
