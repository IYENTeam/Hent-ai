import type { ServiceDatabase } from "./db.js";
import { mergeRelationshipProfile, normalizeRelationshipNotes } from "./conversation-relationship-profile.js";
import { claimArchiveBatch, completeArchiveBatch, markRawArchived, retryArchiveBatch } from "./adaptive-ambient-store-archive.js";
import { persistMembershipSnapshot, recordUnfencedDiagnostic } from "./adaptive-ambient-store-support.js";
import { claimParticipantWork, isParticipantWorkClaimCurrent, renewParticipantWorkClaim } from "./adaptive-ambient-store-claim.js";
export type ServiceClock = () => number;
export type Fence = { readonly key: string; readonly holderId: string; readonly fenceToken: number; readonly expiresAtMs: number };
type Scope = { readonly guildId: string; readonly channelId: string };
type Relationship = { readonly userId: string; readonly rapportDelta: number; readonly familiarityDelta: number; readonly notes: readonly string[] };
export type ParticipantIngressEvent = {
  readonly eventId: string; readonly eventDigest: string; readonly observeOnly: boolean; readonly queue: boolean;
  readonly raw: { readonly scopeId: string; readonly channelId: string; readonly messageId: string; readonly authorRole: "user" | "assistant";
    readonly text: string; readonly eventTs: string; readonly botSelfLoop: boolean; readonly metadata: unknown };
};
type AuditEvidence = {
  readonly evidenceWeight: number; readonly probability: number; readonly draw: number | null;
  readonly driveBefore: number | null; readonly driveAfter: number | null;
  readonly activeHumanCount: number; readonly rosterFresh: boolean;
};
export type OutcomeInput = {
  readonly fence: Fence; readonly eventId: string; readonly scope: Scope; readonly outcome: "invalid" | "observe" | "planned";
  readonly diagnostic?: string | null; readonly proposal?: unknown; readonly auditEvidence?: AuditEvidence;
  readonly state?: { readonly drive: number; readonly version: number; readonly pressure?: number; readonly pressureUpdatedAtMs?: number | null; readonly speakStreak?: number; readonly skipStreak?: number } | null;
  readonly relationships?: readonly Relationship[]; readonly budget?: { readonly key: string; readonly count: number; readonly windowStartMs: number };
  readonly plan?: { readonly id: string; readonly workId: string; readonly chunks: readonly { readonly content: string; readonly nonce: string }[] };
  readonly workId: string; readonly batchHighWatermark?: { readonly createdAtMs: number; readonly workId: string }; readonly failAfterAudit?: boolean;
};

function auditEvidenceFor(input: OutcomeInput): {
  readonly evidenceWeight: number | null; readonly probability: number | null; readonly draw: number | null;
  readonly driveBefore: number | null; readonly driveAfter: number | null;
  readonly activeHumanCount: number | null; readonly rosterFresh: number | null;
} {
  const evidence = input.auditEvidence;
  if (!evidence) return { evidenceWeight: null, probability: null, draw: null, driveBefore: null, driveAfter: null, activeHumanCount: null, rosterFresh: null };
  if (input.outcome === "invalid") {
    return { evidenceWeight: evidence.evidenceWeight, probability: 0, draw: null, driveBefore: null, driveAfter: null,
      activeHumanCount: evidence.activeHumanCount, rosterFresh: Number(evidence.rosterFresh) };
  }
  return { evidenceWeight: evidence.evidenceWeight, probability: evidence.probability, draw: evidence.draw,
    driveBefore: evidence.driveBefore, driveAfter: evidence.driveAfter,
    activeHumanCount: evidence.activeHumanCount, rosterFresh: Number(evidence.rosterFresh) };
}

export class AdaptiveAmbientStore {
  constructor(private readonly serviceDb: ServiceDatabase, private readonly clock: ServiceClock = () => Date.now()) {}
  acquireLease(key: string, holderId: string): Fence | null {
    const now = this.clock();
    this.serviceDb.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.lease(key);
      if (current && current.expiresAtMs > now && current.holderId !== holderId) { this.serviceDb.db.exec("COMMIT"); return null; }
      const token = (current?.fenceToken ?? 0) + (current?.holderId === holderId && current.expiresAtMs > now ? 0 : 1);
      const expiresAtMs = now + 30_000;
      this.serviceDb.db.prepare(`INSERT INTO adaptive_leases (lease_key, holder_id, fence_token, expires_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(lease_key) DO UPDATE SET holder_id=excluded.holder_id, fence_token=excluded.fence_token,
        expires_at_ms=excluded.expires_at_ms, updated_at_ms=excluded.updated_at_ms`).run(key, holderId, token || 1, expiresAtMs, now);
      this.serviceDb.db.exec("COMMIT");
      return { key, holderId, fenceToken: token || 1, expiresAtMs };
    } catch (error) { this.serviceDb.db.exec("ROLLBACK"); throw error; }
  }
  renewLease(fence: Fence): Fence | null {
    const now = this.clock(); const expiresAtMs = now + 30_000;
    const changed = this.serviceDb.db.prepare(`UPDATE adaptive_leases SET expires_at_ms=?, updated_at_ms=?
      WHERE lease_key=? AND holder_id=? AND fence_token=? AND expires_at_ms>?`).run(expiresAtMs, now, fence.key, fence.holderId, fence.fenceToken, now).changes;
    return changed === 1 ? { ...fence, expiresAtMs } : null;
  }
  releaseLease(fence: Fence): boolean {
    return this.serviceDb.db.prepare(`DELETE FROM adaptive_leases WHERE lease_key=? AND holder_id=? AND fence_token=?`)
      .run(fence.key, fence.holderId, fence.fenceToken).changes === 1;
  }

  createWork(input: { id: string; eventId: string; eventDigest: string; scope: Scope; observeOnly?: boolean }): "created" | "idempotent" {
    const now = this.clock(); const existing = this.serviceDb.db.prepare("SELECT event_digest FROM participant_event_work WHERE event_id=? AND guild_id=? AND channel_id=?")
      .get(input.eventId, input.scope.guildId, input.scope.channelId) as { event_digest: string } | undefined;
    if (existing) { if (existing.event_digest !== input.eventDigest) throw new Error("event digest conflict"); return "idempotent"; }
    this.serviceDb.db.prepare(`INSERT INTO participant_event_work (id,event_id,event_digest,guild_id,channel_id,status,observe_only,created_at_ms,updated_at_ms)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(input.id, input.eventId, input.eventDigest, input.scope.guildId, input.scope.channelId, input.observeOnly ? 1 : 0, now, now);
    return "created";
  }

  claimWork(workId: string, fence: Fence): boolean { return claimParticipantWork(this.serviceDb.db, this.clock, workId, fence, this.fencedWhere(), (current, now) => this.fencedArgs(current, now)); }
  renewWorkClaim(workId: string, fence: Fence): boolean { return renewParticipantWorkClaim(this.serviceDb.db, this.clock, workId, fence, this.fencedWhere(), (current, now) => this.fencedArgs(current, now)); }
  isWorkClaimCurrent(workId: string, fence: Fence): boolean { return this.isFenceCurrent(fence) && isParticipantWorkClaimCurrent(this.serviceDb.db, this.clock, workId, fence); }

  recordOutcome(input: OutcomeInput): "applied" | "idempotent" {
    const now = this.clock(); this.serviceDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(input.fence, now);
      const evidence = auditEvidenceFor(input);
      const audit = this.serviceDb.db.prepare(`INSERT INTO adaptive_ambient_audits (event_id,guild_id,channel_id,outcome,diagnostic,proposal_json,recorded_at_ms,
        evidence_weight,probability,draw,drive_before,drive_after,active_human_count,roster_fresh)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id,guild_id,channel_id) DO NOTHING`)
        .run(input.eventId, input.scope.guildId, input.scope.channelId, input.outcome, input.diagnostic ?? null, JSON.stringify(input.proposal ?? null), now,
          evidence.evidenceWeight, evidence.probability, evidence.draw, evidence.driveBefore, evidence.driveAfter, evidence.activeHumanCount, evidence.rosterFresh);
      if (audit.changes === 0) { this.serviceDb.db.exec("COMMIT"); return "idempotent"; }
      if (input.failAfterAudit) throw new Error("forced adaptive transition failure");
      const validTransition = input.outcome !== "invalid" && input.state !== null && input.state !== undefined;
      if (validTransition) this.writeState(input, now);
      if (validTransition && input.relationships) this.mergeRelationships(input, now);
      if (validTransition && input.budget) this.writeBudget(input, now);
      if (validTransition && input.plan) this.writePlan(input, now);
      const status = input.outcome === "planned" ? "planned" : "observe";
      const watermark = input.batchHighWatermark ?? this.workWatermark(input.workId);
      const work = this.serviceDb.db.prepare(`UPDATE participant_event_work SET status=?,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND claim_holder_id=? AND claim_fence_token=?
        AND claim_expires_at_ms>? AND ${this.fencedWhere()}`).run(status, now, input.workId, input.fence.holderId, input.fence.fenceToken, now, ...this.fencedArgs(input.fence, now));
      if (work.changes !== 1) throw new Error("stale fence cannot transition work");
      this.serviceDb.db.prepare(`UPDATE participant_event_work SET status='observe',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
        WHERE guild_id=? AND channel_id=? AND id<>?
          AND (status IN ('pending','retryable') OR (status='claimed' AND claim_expires_at_ms<=?))
          AND (created_at_ms<? OR (created_at_ms=? AND id<=?))`)
        .run(now, input.scope.guildId, input.scope.channelId, input.workId, now, watermark.createdAtMs, watermark.createdAtMs, watermark.workId);
      this.serviceDb.db.exec("COMMIT"); return "applied";
    } catch (error) { this.serviceDb.db.exec("ROLLBACK"); throw error; }
  }

  claimArchiveBatch(input: { batchKey: string; summaryKey: string; scopeId: string; sourceStartId: number; sourceEndId: number; sourceEventIds?: readonly number[]; fence: Fence }): boolean {
    return claimArchiveBatch(this.serviceDb.db, this.clock(), input);
  }
  retryArchiveBatch(batchKey: string, fence: Fence): boolean { return retryArchiveBatch(this.serviceDb.db, this.clock(), batchKey, fence); }
  completeArchiveBatch(batchKey: string, summary: string, fence: Fence, rawEventIds: readonly number[] = []): boolean {
    return completeArchiveBatch(this.serviceDb.db, this.clock(), batchKey, summary, fence, rawEventIds);
  }
  markRawArchived(rawEventId: number, batchKey: string, fence: Fence): boolean { return markRawArchived(this.serviceDb.db, this.clock(), rawEventId, batchKey, fence); }

  cursor(scope: Scope): string | null {
    const row = this.serviceDb.db.prepare("SELECT message_id FROM participant_poll_cursors WHERE guild_id=? AND channel_id=?").get(scope.guildId, scope.channelId) as { message_id: string } | undefined;
    return row?.message_id ?? null;
  }

  setCursor(scope: Scope, messageId: string, fence: Fence): boolean {
    const now = this.clock(); return this.writeCursor(scope, messageId, fence, now);
  }

  ingestForwardEvents(input: { scope: Scope; cursor: string; fence: Fence; events: readonly ParticipantIngressEvent[] }): void {
    const now = this.clock(); this.serviceDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(input.fence, now);
      for (const event of input.events) this.writeIngressEvent(event, input.scope, now);
      if (!this.writeCursor(input.scope, input.cursor, input.fence, now)) throw new Error("stale fence cannot advance cursor");
      this.serviceDb.db.exec("COMMIT");
    } catch (error) { this.serviceDb.db.exec("ROLLBACK"); throw error; }
  }

  claimNextWork(scope: Scope, fence: Fence): string | null {
    const rows = this.serviceDb.db.prepare(`SELECT id FROM participant_event_work WHERE guild_id=? AND channel_id=?
      AND (status IN ('pending','retryable') OR (status='claimed' AND claim_expires_at_ms<=?))
      ORDER BY observe_only ASC,created_at_ms DESC,id DESC`).all(scope.guildId, scope.channelId, this.clock()) as { id: string }[];
    for (const row of rows) if (this.claimWork(row.id, fence)) return row.id;
    return null;
  }

  pendingDeliveryPlanIds(scope: Scope): readonly string[] {
    return this.serviceDb.db.prepare("SELECT id FROM participant_delivery_plans WHERE guild_id=? AND channel_id=? AND status='pending' ORDER BY created_at_ms,id")
      .all(scope.guildId, scope.channelId).map((row) => String((row as { id: string }).id));
  }

  isFenceCurrent(fence: Fence): boolean {
    return this.serviceDb.db.prepare(`SELECT 1 WHERE ${this.fencedWhere()}`).get(...this.fencedArgs(fence, this.clock())) !== undefined;
  }

  work(id: string): { readonly id: string; readonly eventId: string; readonly scope: Scope; readonly observeOnly: boolean; readonly status: string; readonly createdAtMs: number } | null {
    const row = this.serviceDb.db.prepare(`SELECT id,event_id,guild_id,channel_id,observe_only,status,created_at_ms FROM participant_event_work WHERE id=?`).get(id) as
      { id: string; event_id: string; guild_id: string; channel_id: string; observe_only: number; status: string; created_at_ms: number } | undefined;
    return row ? { id: row.id, eventId: row.event_id, scope: { guildId: row.guild_id, channelId: row.channel_id }, observeOnly: row.observe_only === 1, status: row.status, createdAtMs: row.created_at_ms } : null;
  }

  budget(scope: Scope, key: string): { readonly count: number; readonly windowStartMs: number } | null {
    const row = this.serviceDb.db.prepare("SELECT count,window_start_ms FROM adaptive_budgets WHERE scope_key=? AND budget_key=?")
      .get(`${scope.guildId}:${scope.channelId}`, key) as { count: number; window_start_ms: number } | undefined;
    return row ? { count: row.count, windowStartMs: row.window_start_ms } : null;
  }

  recordUnfencedDiagnostic(fence: Fence, diagnostic: string): void {
    recordUnfencedDiagnostic(this.serviceDb.db, this.clock(), fence, diagnostic);
  }

  recordReceipt(planId: string, chunkIndex: number, nonce: string, discordMessageId: string, fence: Fence): boolean {
    const now = this.clock(); return this.serviceDb.db.prepare(`INSERT OR IGNORE INTO participant_delivery_receipts (plan_id,chunk_index,nonce,discord_message_id,received_at_ms)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM participant_delivery_chunks WHERE plan_id=? AND chunk_index=? AND nonce=?)
      AND ${this.fencedWhere()}`).run(planId, chunkIndex, nonce, discordMessageId, now, planId, chunkIndex, nonce, ...this.fencedArgs(fence, now)).changes === 1;
  }

  deliveryPlan(planId: string): { readonly id: string; readonly channelId: string; readonly status: string; readonly chunks: readonly { readonly index: number; readonly content: string; readonly nonce: string; readonly receipt: { readonly nonce: string; readonly discordMessageId: string } | null }[] } | null {
    const plan = this.serviceDb.db.prepare("SELECT id,channel_id,status FROM participant_delivery_plans WHERE id=?").get(planId) as { id: string; channel_id: string; status: string } | undefined;
    if (!plan) return null;
    const chunks = this.serviceDb.db.prepare(`SELECT c.chunk_index,c.content,c.nonce,r.nonce AS receipt_nonce,r.discord_message_id
      FROM participant_delivery_chunks c LEFT JOIN participant_delivery_receipts r ON r.plan_id=c.plan_id AND r.chunk_index=c.chunk_index
      WHERE c.plan_id=? ORDER BY c.chunk_index`).all(planId) as { chunk_index: number; content: string; nonce: string; receipt_nonce: string | null; discord_message_id: string | null }[];
    return { id: plan.id, channelId: plan.channel_id, status: plan.status, chunks: chunks.map((chunk) => ({ index: chunk.chunk_index, content: chunk.content, nonce: chunk.nonce,
      receipt: chunk.receipt_nonce === null || chunk.discord_message_id === null ? null : { nonce: chunk.receipt_nonce, discordMessageId: chunk.discord_message_id } })) };
  }

  markDeliveryRetryable(planId: string, fence: Fence): boolean { return this.transitionDelivery(planId, "retryable", fence); }
  cancelDelivery(planId: string, fence: Fence): boolean { return this.transitionDelivery(planId, "cancelled", fence); }

  finalizeDelivery(planId: string, fence: Fence): "delivered" | "idempotent" | "incomplete" | "stale" {
    const now = this.clock(); this.serviceDb.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.isFenceCurrent(fence)) { this.serviceDb.db.exec("ROLLBACK"); return "stale"; }
      const plan = this.serviceDb.db.prepare("SELECT work_id,status FROM participant_delivery_plans WHERE id=?").get(planId) as { work_id: string; status: string } | undefined;
      if (!plan) { this.serviceDb.db.exec("ROLLBACK"); return "incomplete"; }
      if (plan.status === "delivered") { this.serviceDb.db.exec("COMMIT"); return "idempotent"; }
      const missing = this.serviceDb.db.prepare(`SELECT 1 FROM participant_delivery_chunks c LEFT JOIN participant_delivery_receipts r
        ON r.plan_id=c.plan_id AND r.chunk_index=c.chunk_index AND r.nonce=c.nonce WHERE c.plan_id=? AND r.plan_id IS NULL LIMIT 1`).get(planId);
      if (missing || plan.status !== "pending") { this.serviceDb.db.exec("ROLLBACK"); return "incomplete"; }
      const updated = this.serviceDb.db.prepare(`UPDATE participant_delivery_plans SET status='delivered',updated_at_ms=? WHERE id=? AND status='pending' AND ${this.fencedWhere()}`)
        .run(now, planId, ...this.fencedArgs(fence, now));
      const work = this.serviceDb.db.prepare(`UPDATE participant_event_work SET status='delivered',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND status='planned' AND ${this.fencedWhere()}`)
        .run(now, plan.work_id, ...this.fencedArgs(fence, now));
      if (updated.changes !== 1 || work.changes !== 1) { this.serviceDb.db.exec("ROLLBACK"); return "stale"; }
      this.serviceDb.db.exec("COMMIT"); return "delivered";
    } catch (error) { this.serviceDb.db.exec("ROLLBACK"); throw error; }
  }


  persistMembershipSnapshot(scope: Scope, memberIds: readonly string[], complete: boolean, observedAtMs: number, fence: Fence): boolean {
    const now = this.clock();
    return persistMembershipSnapshot(this.serviceDb.db, scope, memberIds, complete, observedAtMs, fence, now, (current, at) => this.fencedArgs(current, at));
  }

  state(scope: Scope): { drive: number; version: number; updatedAtMs: number; pressure: number; pressureUpdatedAtMs: number | null; speakStreak: number; skipStreak: number } | null {
    return (this.serviceDb.db.prepare("SELECT drive,version,updated_at_ms AS updatedAtMs,pressure,pressure_updated_at_ms AS pressureUpdatedAtMs,COALESCE(speak_streak, 0) AS speakStreak,COALESCE(skip_streak, 0) AS skipStreak FROM adaptive_ambient_state WHERE guild_id=? AND channel_id=?")
      .get(scope.guildId, scope.channelId) as { drive: number; version: number; updatedAtMs: number; pressure: number; pressureUpdatedAtMs: number | null; speakStreak: number; skipStreak: number } | undefined) ?? null;
  }
  counts(): Record<string, number> { const table = (name: string) => Number((this.serviceDb.db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count); return { audits: table("adaptive_ambient_audits"), states: table("adaptive_ambient_state"), budgets: table("adaptive_budgets"), relationships: table("adaptive_relationship_profiles"), plans: table("participant_delivery_plans") }; }
  private transitionDelivery(planId: string, status: "retryable" | "cancelled", fence: Fence): boolean {
    const now = this.clock(); this.serviceDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence, now); const args = this.fencedArgs(fence, now);
      const plan = this.serviceDb.db.prepare(`UPDATE participant_delivery_plans SET status=?,updated_at_ms=? WHERE id=? AND status='pending' AND ${this.fencedWhere()}`).run(status === "retryable" ? "pending" : "cancelled", now, planId, ...args);
      const work = plan.changes === 1 && this.serviceDb.db.prepare(`UPDATE participant_event_work SET status=?,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=(SELECT work_id FROM participant_delivery_plans WHERE id=?) AND status='planned' AND ${this.fencedWhere()}`).run(status === "retryable" ? "planned" : "observe", now, planId, ...args);
      if (!work || work.changes !== 1) { this.serviceDb.db.exec("ROLLBACK"); return false; } this.serviceDb.db.exec("COMMIT"); return true;
    } catch (error) { this.serviceDb.db.exec("ROLLBACK"); throw error; }
  }
  private writeCursor(scope: Scope, messageId: string, fence: Fence, now: number): boolean {
    return this.serviceDb.db.prepare(`INSERT INTO participant_poll_cursors (guild_id,channel_id,message_id,updated_at_ms)
      SELECT ?, ?, ?, ? WHERE ${this.fencedWhere()} ON CONFLICT(guild_id,channel_id) DO UPDATE SET message_id=excluded.message_id,updated_at_ms=excluded.updated_at_ms`)
      .run(scope.guildId, scope.channelId, messageId, now, ...this.fencedArgs(fence, now)).changes === 1;
  }
  private writeIngressEvent(event: ParticipantIngressEvent, scope: Scope, now: number): void {
    const metadata = JSON.stringify(event.raw.metadata);
    const existing = this.serviceDb.db.prepare(`SELECT text,event_ts,author_role,bot_self_loop,metadata_json FROM conversation_raw_events
      WHERE scope_id=? AND message_id=? AND author_source='discord-participant'`).get(event.raw.scopeId, event.raw.messageId) as { text: string; event_ts: string; author_role: string; bot_self_loop: number; metadata_json: string } | undefined;
    if (existing) {
      if (existing.text !== event.raw.text || existing.event_ts !== event.raw.eventTs || existing.author_role !== event.raw.authorRole || existing.bot_self_loop !== Number(event.raw.botSelfLoop) || existing.metadata_json !== metadata) throw new Error("event digest conflict");
    } else {
      this.serviceDb.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
        VALUES (?, ?, NULL, NULL, ?, ?, 'discord-participant', ?, ?, ?, ?, ?, ?)`)
        .run(event.raw.scopeId, event.raw.channelId, event.raw.messageId, event.raw.authorRole, event.raw.text, event.raw.eventTs, new Date(now).toISOString(), Number(event.raw.botSelfLoop), metadata, new Date(now).toISOString());
    }
    if (event.queue) this.createWork({ id: `discord:${scope.guildId}:${scope.channelId}:${event.eventId}`, eventId: event.eventId, eventDigest: event.eventDigest, scope, observeOnly: event.observeOnly });
  }
  private lease(key: string): Fence | null { const row = this.serviceDb.db.prepare("SELECT holder_id,fence_token,expires_at_ms FROM adaptive_leases WHERE lease_key=?").get(key) as { holder_id: string; fence_token: number; expires_at_ms: number } | undefined; return row ? { key, holderId: row.holder_id, fenceToken: row.fence_token, expiresAtMs: row.expires_at_ms } : null; }
  private requireFence(fence: Fence, now: number): void { if (!this.serviceDb.db.prepare(`SELECT 1 FROM adaptive_leases WHERE ${this.fencedWhere()}`).get(...this.fencedArgs(fence, now))) throw new Error("stale fence"); }
  private fencedWhere(): string { return "EXISTS (SELECT 1 FROM adaptive_leases l WHERE l.lease_key=? AND l.holder_id=? AND l.fence_token=? AND l.expires_at_ms>?)"; }
  private fencedArgs(fence: Fence, now: number): [string, string, number, number] { return [fence.key, fence.holderId, fence.fenceToken, now]; }
  private workWatermark(workId: string): { readonly createdAtMs: number; readonly workId: string } {
    const row = this.serviceDb.db.prepare("SELECT created_at_ms FROM participant_event_work WHERE id=?").get(workId) as { created_at_ms: number } | undefined;
    if (!row) throw new Error("work high-watermark is missing");
    return { createdAtMs: row.created_at_ms, workId };
  }
  private writeState(input: OutcomeInput, now: number): void {
    const state = input.state!;
    this.serviceDb.db.prepare(`INSERT INTO adaptive_ambient_state (guild_id,channel_id,drive,version,updated_at_ms,pressure,pressure_updated_at_ms,speak_streak,skip_streak) VALUES (?, ?, ?, ?, ?, COALESCE(?, 0), ?, COALESCE(?, 0), COALESCE(?, 0))
      ON CONFLICT(guild_id,channel_id) DO UPDATE SET drive=excluded.drive,version=excluded.version,updated_at_ms=excluded.updated_at_ms,
      pressure=CASE WHEN ? IS NULL THEN adaptive_ambient_state.pressure ELSE excluded.pressure END,
      pressure_updated_at_ms=CASE WHEN ? IS NULL THEN adaptive_ambient_state.pressure_updated_at_ms ELSE excluded.pressure_updated_at_ms END,
      speak_streak=excluded.speak_streak,skip_streak=excluded.skip_streak`)
      .run(input.scope.guildId, input.scope.channelId, state.drive, state.version, now, state.pressure ?? null, state.pressureUpdatedAtMs ?? null, state.speakStreak ?? null, state.skipStreak ?? null, state.pressure ?? null, state.pressure ?? null);
  }
  private mergeRelationships(input: OutcomeInput, now: number): void { for (const [index, relation] of (input.relationships ?? []).entries()) {
    const notes = normalizeRelationshipNotes(relation.notes);
    const added = this.serviceDb.db.prepare(`INSERT OR IGNORE INTO adaptive_relationship_ledger (event_id,user_id,proposal_index,guild_id,channel_id,rapport_delta,familiarity_delta,notes_json,created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.eventId, relation.userId, index, input.scope.guildId, input.scope.channelId, relation.rapportDelta, relation.familiarityDelta, JSON.stringify(notes), now);
    if (added.changes === 0) continue;
    const current = this.serviceDb.db.prepare("SELECT rapport,familiarity,notes_json FROM adaptive_relationship_profiles WHERE guild_id=? AND channel_id=? AND user_id=?")
      .get(input.scope.guildId, input.scope.channelId, relation.userId) as { rapport: number; familiarity: number; notes_json: string } | undefined;
    const merged = mergeRelationshipProfile(current ? { rapport: current.rapport, familiarity: current.familiarity, notes: parseNotes(current.notes_json) } : null, { rapportDelta: relation.rapportDelta, familiarityDelta: relation.familiarityDelta, notes });
    this.serviceDb.db.prepare(`INSERT INTO adaptive_relationship_profiles (guild_id,channel_id,user_id,rapport,familiarity,notes_json,updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id,user_id) DO UPDATE SET rapport=excluded.rapport,familiarity=excluded.familiarity,notes_json=excluded.notes_json,updated_at_ms=excluded.updated_at_ms
      WHERE adaptive_relationship_profiles.channel_id=excluded.channel_id`)
      .run(input.scope.guildId, input.scope.channelId, relation.userId, merged.rapport, merged.familiarity, JSON.stringify(merged.notes), now);
  } }
  private writeBudget(input: OutcomeInput, now: number): void { const budget = input.budget!; this.serviceDb.db.prepare(`INSERT INTO adaptive_budgets (scope_key,budget_key,count,window_start_ms,updated_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope_key,budget_key) DO UPDATE SET count=excluded.count,window_start_ms=excluded.window_start_ms,updated_at_ms=excluded.updated_at_ms`).run(`${input.scope.guildId}:${input.scope.channelId}`, budget.key, budget.count, budget.windowStartMs, now); }
  private writePlan(input: OutcomeInput, now: number): void { const plan=input.plan!; this.serviceDb.db.prepare("INSERT INTO participant_delivery_plans (id,work_id,guild_id,channel_id,status,created_at_ms,updated_at_ms) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(plan.id, plan.workId, input.scope.guildId, input.scope.channelId, now, now); for (const [index, chunk] of plan.chunks.entries()) this.serviceDb.db.prepare("INSERT INTO participant_delivery_chunks (plan_id,chunk_index,content,nonce) VALUES (?, ?, ?, ?)").run(plan.id,index,chunk.content,chunk.nonce); }
}
function parseNotes(value: string): readonly string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((note): note is string => typeof note === "string") : []; } catch { return []; } }

export function createAdaptiveAmbientStore(db: ServiceDatabase, clock?: ServiceClock): AdaptiveAmbientStore { return new AdaptiveAmbientStore(db, clock); }
