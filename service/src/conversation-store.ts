import type { ServiceDatabase } from "./db.js";
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
  RawRetentionInput,
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

  pruneRawEvents(input: RawRetentionInput): number {
    const cutoff = new Date(new Date(input.now).getTime() - input.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.serviceDb.db.prepare("DELETE FROM conversation_raw_events WHERE event_ts < ?").run(cutoff).changes;
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
