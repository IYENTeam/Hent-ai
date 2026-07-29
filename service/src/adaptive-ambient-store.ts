import { createHash } from "node:crypto";
import { materializeConversationParticipantContext, type ConversationParticipantRawEvent } from "./conversation-participant-context.js";
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
export type ParticipationMode = "apply" | "shadow";
export type ParticipationPersona = { readonly source: "channel_profile" | "configured_global" | "generic"; readonly text: string; readonly utf8Bytes: number; readonly digest: string; readonly revision: string };
export type ParticipationSnapshot = { readonly highWatermarkId: number; readonly json: string; readonly utf8Bytes: number; readonly digest: string; readonly turns: readonly { readonly rawEventId: number; readonly content: string; readonly utf8Bytes: number; readonly digest: string }[] };
export type ParticipationTickInput = { readonly id: string; readonly scope: Scope; readonly mode: ParticipationMode; readonly primaryContractVersion: string; readonly anchorWorkId: string; readonly snapshot: ParticipationSnapshot; readonly persona: ParticipationPersona; readonly coverageWorkIds: readonly string[]; readonly fence: Fence };
export type ParticipationValidationOutput = { readonly missedOpportunity: number; readonly interruption: number; readonly confidence: number; readonly priorDelta: number; readonly rationale: string; readonly rationaleUtf8Bytes: number };
const PARTICIPATION_CLAIM_TTL_MS = 30_000;
const SNAPSHOT_BYTES_MAX = 49_152;
const PERSONA_BYTES_MAX = 8_192;
const TURN_BYTES_MAX = 8_192;
const PRIMARY_RESULT_BYTES_MAX = 9_216;
const PRIMARY_CHUNK_BYTES_MAX = 1_800;

function verifyCanonicalContent(content: string, utf8Bytes: number, digest: string, minBytes: number, maxBytes: number, label: string): { readonly utf8Bytes: number; readonly digest: string } {
  const actualBytes = Buffer.byteLength(content, "utf8");
  const actualDigest = createHash("sha256").update(content, "utf8").digest("hex");
  if (actualBytes < minBytes || actualBytes > maxBytes || utf8Bytes !== actualBytes || digest !== actualDigest) throw new Error(`invalid ${label} metadata`);
  return { utf8Bytes: actualBytes, digest: actualDigest };
}

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
        WHERE guild_id=? AND channel_id=? AND id<>? AND participation_tick_id IS NULL
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
      AND participation_tick_id IS NULL AND (status IN ('pending','retryable') OR (status='claimed' AND claim_expires_at_ms<=?))
      ORDER BY observe_only ASC,created_at_ms DESC,id DESC`).all(scope.guildId, scope.channelId, this.clock()) as { id: string }[];
    for (const row of rows) if (this.claimWork(row.id, fence)) return row.id;
    return null;
  }
  terminalizeParticipationObserveOnly(scope: Scope, highWatermarkId: number, fence: Fence): number {
    const now = this.clock();
    this.requireFence(fence, now);
    return this.serviceDb.db.prepare(`UPDATE participant_event_work
      SET status='observe',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
      WHERE guild_id=? AND channel_id=? AND observe_only=1 AND participation_tick_id IS NULL
        AND (status IN ('pending','retryable') OR (status='claimed' AND claim_expires_at_ms<=?))
        AND EXISTS (SELECT 1 FROM conversation_raw_events r
          WHERE r.message_id=participant_event_work.event_id
            AND r.scope_id=? AND r.author_source='discord-participant' AND r.id<=?)`)
      .run(now, scope.guildId, scope.channelId, now, `discord:${scope.guildId}:${scope.channelId}`, highWatermarkId).changes;
  }
  terminalizeParticipationInvalidContext(scope: Scope, workId: string, reason: "context_truncated" | "snapshot_corrupt", fence: Fence): boolean {
    const now = this.clock();
    this.requireFence(fence, now);
    const changed = this.serviceDb.db.prepare(`UPDATE participant_event_work
      SET status='observe',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
      WHERE id=? AND guild_id=? AND channel_id=? AND participation_tick_id IS NULL
        AND (status IN ('pending','retryable') OR (status='claimed' AND claim_expires_at_ms<=?)) AND ${this.fencedWhere()}`)
      .run(now, workId, scope.guildId, scope.channelId, now, ...this.fencedArgs(fence, now)).changes;
    return changed === 1;
  }
  bindParticipationTick(input: ParticipationTickInput): boolean {
    const now = this.clock(); const db = this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(input.fence, now);
      const scopeId = `discord:${input.scope.guildId}:${input.scope.channelId}`;
      const watermark = db.prepare(`SELECT MAX(id) AS id FROM conversation_raw_events
        WHERE scope_id=?`).get(scopeId) as { id: number | null };
      if (watermark.id === null || input.snapshot.highWatermarkId !== watermark.id) { db.exec("COMMIT"); return false; }
      const watermarkId = watermark.id;
      const candidates = db.prepare(`SELECT w.id FROM participant_event_work w JOIN conversation_raw_events r ON r.message_id=w.event_id
        WHERE w.guild_id=? AND w.channel_id=? AND w.participation_tick_id IS NULL
          AND (w.status IN ('pending','retryable') OR (w.status='claimed' AND w.claim_expires_at_ms<=?))
          AND w.observe_only=0 AND r.scope_id=? AND r.author_source='discord-participant' AND r.author_role='user' AND r.id<=?
          AND NOT EXISTS (SELECT 1 FROM conversation_participation_coverage c WHERE c.work_id=w.id AND c.coverage_kind=?)
        ORDER BY w.created_at_ms DESC,w.id DESC LIMIT 120`).all(input.scope.guildId, input.scope.channelId, now, scopeId, watermarkId, input.mode) as { id: string }[];
      const candidateIds = new Set(candidates.map((candidate) => candidate.id));
      if (candidates.length === 0 || candidates[0]!.id !== input.anchorWorkId
        || candidateIds.size !== input.coverageWorkIds.length
        || input.coverageWorkIds.some((workId) => !candidateIds.has(workId))) { db.exec("COMMIT"); return false; }
      const snapshot = verifyCanonicalContent(input.snapshot.json, input.snapshot.utf8Bytes, input.snapshot.digest, 2, SNAPSHOT_BYTES_MAX, "snapshot");
      const persona = verifyCanonicalContent(input.persona.text, input.persona.utf8Bytes, input.persona.digest, 1, PERSONA_BYTES_MAX, "persona");
      const turns = input.snapshot.turns.map((turn) => ({ ...turn, ...verifyCanonicalContent(turn.content, turn.utf8Bytes, turn.digest, 0, TURN_BYTES_MAX, "snapshot turn") }));
      if (turns.some((turn) => turn.rawEventId > watermarkId)) { db.exec("COMMIT"); return false; }
      db.prepare(`INSERT INTO conversation_participation_ticks (id,guild_id,channel_id,mode,primary_contract_version,status,anchor_work_id,snapshot_high_watermark_id,snapshot_json,snapshot_utf8_bytes,snapshot_digest,persona_source,persona_text,persona_utf8_bytes,persona_digest,persona_revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'bound',?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.scope.guildId,input.scope.channelId,input.mode,input.primaryContractVersion,input.anchorWorkId,input.snapshot.highWatermarkId,input.snapshot.json,snapshot.utf8Bytes,snapshot.digest,input.persona.source,input.persona.text,persona.utf8Bytes,persona.digest,input.persona.revision,now,now);
      for (const [ordinal, turn] of turns.entries()) db.prepare("INSERT INTO conversation_participation_snapshot_turns (tick_id,ordinal,raw_event_id,content,content_utf8_bytes,content_digest) VALUES (?,?,?,?,?,?)").run(input.id,ordinal,turn.rawEventId,turn.content,turn.utf8Bytes,turn.digest);
      for (const workId of input.coverageWorkIds) db.prepare("INSERT INTO conversation_participation_coverage (tick_id,work_id,coverage_kind) VALUES (?,?,?)").run(input.id,workId,input.mode);
      if (input.mode === "apply") {
        const anchor = db.prepare(`UPDATE participant_event_work SET status='retryable',participation_tick_id=?,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND participation_tick_id IS NULL AND ${this.fencedWhere()}`).run(input.id,now,input.anchorWorkId,...this.fencedArgs(input.fence,now));
        if (anchor.changes !== 1) throw new Error("apply anchor unavailable");
        for (const workId of input.coverageWorkIds) if (workId !== input.anchorWorkId) db.prepare(`UPDATE participant_event_work SET status='covered',participation_tick_id=?,updated_at_ms=? WHERE id=? AND participation_tick_id IS NULL`).run(input.id,now,workId);
      }
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  claimParticipationPrimary(tickId: string, fence: Fence): boolean {
    const now=this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence,now);
      const changed=db.prepare(`UPDATE conversation_participation_ticks SET status='primary_claimed',primary_claim_holder_id=?,primary_claim_fence_token=?,primary_claim_expires_at_ms=?,primary_attempt_count=primary_attempt_count+1,updated_at_ms=? WHERE id=? AND status IN ('bound','primary_retry_wait') AND primary_attempt_count<3 AND ${this.fencedWhere()}`).run(fence.holderId,fence.fenceToken,now+PARTICIPATION_CLAIM_TTL_MS,now,tickId,...this.fencedArgs(fence,now));
      if (!changed.changes) { db.exec("COMMIT"); return false; }
      db.prepare(`UPDATE participant_event_work SET status='claimed',claim_holder_id=?,claim_fence_token=?,claim_expires_at_ms=?,updated_at_ms=? WHERE participation_tick_id=? AND id=(SELECT anchor_work_id FROM conversation_participation_ticks WHERE id=?)`).run(fence.holderId,fence.fenceToken,now+PARTICIPATION_CLAIM_TTL_MS,now,tickId,tickId);
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  abortParticipationTick(tickId:string, reason:"scope_fence_lost"|"explicit_predecision", fence:Fence): boolean {
    const now=this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence,now); const changed=db.prepare(`UPDATE conversation_participation_ticks SET status='aborted',abort_reason=?,primary_claim_holder_id=NULL,primary_claim_fence_token=NULL,primary_claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND primary_result_json IS NULL AND status IN ('bound','budget_wait','primary_claimed','primary_retry_wait') AND ${this.fencedWhere()}`).run(reason,now,tickId,...this.fencedArgs(fence,now));
      if (!changed.changes) { db.exec("COMMIT"); return false; }
      db.prepare("DELETE FROM conversation_participation_coverage WHERE tick_id=? AND coverage_kind='apply'").run(tickId);
      db.prepare("UPDATE participant_event_work SET status='retryable',participation_tick_id=NULL,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE participation_tick_id=?").run(now,tickId);
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  claimParticipationValidation(tickId:string, fence:Fence): boolean {
    const now=this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence,now);
      const claimed=db.prepare(`UPDATE conversation_participation_validations SET status='claimed',claim_holder_id=?,claim_fence_token=?,claim_expires_at_ms=?,attempt_count=attempt_count+1,updated_at_ms=? WHERE tick_id=? AND status='pending' AND attempt_count<3 AND ${this.fencedWhere()}`)
        .run(fence.holderId,fence.fenceToken,now+PARTICIPATION_CLAIM_TTL_MS,now,tickId,...this.fencedArgs(fence,now));
      if (claimed.changes !== 1) { db.exec("COMMIT"); return false; }
      const tick=db.prepare(`UPDATE conversation_participation_ticks SET status='validation_claimed',updated_at_ms=? WHERE id=? AND status='decided' AND ${this.fencedWhere()}`)
        .run(now,tickId,...this.fencedArgs(fence,now));
      if (tick.changes !== 1) { db.exec("ROLLBACK"); return false; }
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  retryParticipationPrimary(tickId: string, fence: Fence): boolean {
    const now=this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence,now);
      const tick=db.prepare(`UPDATE conversation_participation_ticks SET status=CASE WHEN primary_attempt_count>=3 THEN 'primary_unavailable' ELSE 'primary_retry_wait' END,primary_claim_holder_id=NULL,primary_claim_fence_token=NULL,primary_claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND status='primary_claimed' AND primary_claim_holder_id=? AND primary_claim_fence_token=? AND ${this.fencedWhere()}`)
        .run(now,tickId,fence.holderId,fence.fenceToken,...this.fencedArgs(fence,now));
      if (tick.changes !== 1) { db.exec("COMMIT"); return false; }
      db.prepare(`UPDATE participant_event_work SET status='observe',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
        WHERE id=(SELECT anchor_work_id FROM conversation_participation_ticks WHERE id=? AND status='primary_unavailable') AND status='claimed' AND ${this.fencedWhere()}`)
        .run(now,tickId,...this.fencedArgs(fence,now));
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  failParticipationPrimary(tickId: string, reason: "invalid" | "unavailable", fence: Fence): boolean {
    const now=this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence,now);
      const tick=db.prepare(`UPDATE conversation_participation_ticks SET status=CASE WHEN ?='invalid' THEN 'primary_invalid' WHEN primary_attempt_count>=3 THEN 'primary_unavailable' ELSE 'primary_retry_wait' END,primary_claim_holder_id=NULL,primary_claim_fence_token=NULL,primary_claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND status='primary_claimed' AND primary_claim_holder_id=? AND primary_claim_fence_token=? AND ${this.fencedWhere()}`)
        .run(reason,now,tickId,fence.holderId,fence.fenceToken,...this.fencedArgs(fence,now));
      if (tick.changes !== 1) { db.exec("COMMIT"); return false; }
      db.prepare(`UPDATE participant_event_work SET status='observe',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
        WHERE id=(SELECT anchor_work_id FROM conversation_participation_ticks WHERE id=? AND status IN ('primary_invalid','primary_unavailable')) AND status='claimed' AND ${this.fencedWhere()}`)
        .run(now,tickId,...this.fencedArgs(fence,now));
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  recoverExpiredParticipationClaims(scope: Scope, fence: Fence): number;
  recoverExpiredParticipationClaims(fence: Fence): number;
  recoverExpiredParticipationClaims(scopeOrFence: Scope | Fence, suppliedFence?: Fence): number {
    if (!suppliedFence) return 0;
    const scope=scopeOrFence as Scope, fence=suppliedFence, now=this.clock(), db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence,now);
      const corruptTickIds=this.corruptParticipationTickIds(scope);
      for (const tickId of corruptTickIds) {
        db.prepare(`UPDATE conversation_participation_ticks SET status='corrupt',primary_claim_holder_id=NULL,primary_claim_fence_token=NULL,primary_claim_expires_at_ms=NULL,updated_at_ms=?
          WHERE id=? AND guild_id=? AND channel_id=? AND status NOT IN ('validated','validation_unavailable','corrupt','aborted') AND ${this.fencedWhere()}`)
          .run(now,tickId,scope.guildId,scope.channelId,...this.fencedArgs(fence,now));
        db.prepare(`UPDATE conversation_participation_validations SET status='corrupt',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
          WHERE tick_id=? AND status NOT IN ('applied','accepted_shadow','unavailable','corrupt')`).run(now,tickId);
        db.prepare(`UPDATE participant_event_work SET status='observe',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
          WHERE id=(SELECT anchor_work_id FROM conversation_participation_ticks WHERE id=? AND guild_id=? AND channel_id=?) AND status='claimed' AND ${this.fencedWhere()}`)
          .run(now,tickId,scope.guildId,scope.channelId,...this.fencedArgs(fence,now));
      }
      const primary=db.prepare(`UPDATE conversation_participation_ticks SET status=CASE WHEN primary_attempt_count>=3 THEN 'primary_unavailable' ELSE 'primary_retry_wait' END,primary_claim_holder_id=NULL,primary_claim_fence_token=NULL,primary_claim_expires_at_ms=NULL,updated_at_ms=? WHERE guild_id=? AND channel_id=? AND status='primary_claimed' AND primary_claim_expires_at_ms<=? AND ${this.fencedWhere()}`).run(now,scope.guildId,scope.channelId,now,...this.fencedArgs(fence,now)).changes;
      db.prepare(`UPDATE participant_event_work SET status='observe',claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
        WHERE id IN (SELECT anchor_work_id FROM conversation_participation_ticks WHERE guild_id=? AND channel_id=? AND status='primary_unavailable' AND updated_at_ms=?) AND status='claimed' AND ${this.fencedWhere()}`).run(now,scope.guildId,scope.channelId,now,...this.fencedArgs(fence,now));
      const validation=db.prepare(`UPDATE conversation_participation_validations SET status=CASE WHEN attempt_count>=3 THEN 'unavailable' ELSE 'pending' END,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE status='claimed' AND claim_expires_at_ms<=? AND tick_id IN (SELECT id FROM conversation_participation_ticks WHERE guild_id=? AND channel_id=?) AND ${this.fencedWhere()}`).run(now,now,scope.guildId,scope.channelId,...this.fencedArgs(fence,now)).changes;
      db.prepare(`UPDATE conversation_participation_ticks SET status=CASE
        WHEN (SELECT status FROM conversation_participation_validations WHERE tick_id=conversation_participation_ticks.id)='unavailable' THEN 'validation_unavailable'
        ELSE 'decided' END,updated_at_ms=?
        WHERE guild_id=? AND channel_id=? AND id IN (SELECT tick_id FROM conversation_participation_validations WHERE status IN ('pending','unavailable') AND updated_at_ms=?) AND status='validation_claimed' AND ${this.fencedWhere()}`).run(now,scope.guildId,scope.channelId,now,...this.fencedArgs(fence,now));
      db.exec("COMMIT"); return primary+validation+corruptTickIds.length;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  persistParticipationPrimary(input: { readonly tickId:string; readonly fence:Fence; readonly resultJson:string; readonly resultUtf8Bytes:number; readonly resultDigest:string; readonly decision:"observe"|"speak"; readonly validationSchemaVersion:string; readonly validatorModel:string; readonly chunks?:readonly string[]; readonly workId?:string; readonly scope?:Scope; readonly budget?:{readonly key:string;readonly count:number;readonly windowStartMs:number;readonly limit:number} }): boolean {
    const now=this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(input.fence,now);
      const tick=db.prepare("SELECT mode,anchor_work_id,guild_id,channel_id FROM conversation_participation_ticks WHERE id=?").get(input.tickId) as {mode:ParticipationMode;anchor_work_id:string;guild_id:string;channel_id:string}|undefined;
      if (!tick) { db.exec("COMMIT"); return false; }
      const result = verifyCanonicalContent(input.resultJson, input.resultUtf8Bytes, input.resultDigest, 1, PRIMARY_RESULT_BYTES_MAX, "primary result");
      const chunks = input.chunks?.map((content) => ({ content, ...verifyCanonicalContent(content, Buffer.byteLength(content, "utf8"), createHash("sha256").update(content, "utf8").digest("hex"), 1, PRIMARY_CHUNK_BYTES_MAX, "primary chunk") }));
      const needsPlan=tick.mode==="apply"&&input.decision==="speak";
      if (needsPlan && (!chunks?.length || !input.workId || !input.scope || input.workId!==tick.anchor_work_id || input.scope.guildId!==tick.guild_id || input.scope.channelId!==tick.channel_id)) throw new Error("apply speak requires bound plan input");
      const changed=db.prepare(`UPDATE conversation_participation_ticks SET status='decided',primary_result_json=?,primary_result_utf8_bytes=?,primary_result_digest=?,delivery_disposition=?,primary_claim_holder_id=NULL,primary_claim_fence_token=NULL,primary_claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND status='primary_claimed' AND primary_claim_holder_id=? AND primary_claim_fence_token=? AND primary_claim_expires_at_ms>? AND ${this.fencedWhere()}`).run(input.resultJson,result.utf8Bytes,result.digest,needsPlan?"pending":"not_applicable",now,input.tickId,input.fence.holderId,input.fence.fenceToken,now,...this.fencedArgs(input.fence,now));
      if (!changed.changes) { db.exec("COMMIT"); return false; }
      if (input.budget && !this.admitBudget({ scope:{guildId:tick.guild_id,channelId:tick.channel_id}, budget:input.budget },now)) { db.exec("ROLLBACK"); return false; }
      db.prepare("INSERT INTO conversation_participation_validations (tick_id,status,schema_version,model,created_at_ms,updated_at_ms) VALUES (?,'pending',?,?,?,?)").run(input.tickId,input.validationSchemaVersion,input.validatorModel,now,now);
      if (needsPlan) {
        const planId=`participation:${input.tickId}`;
        db.prepare("INSERT INTO participant_delivery_plans (id,work_id,guild_id,channel_id,status,created_at_ms,updated_at_ms,decision_version,tick_id) VALUES (?,?,?,?, 'pending',?,?, 'v2',?)").run(planId,tick.anchor_work_id,tick.guild_id,tick.channel_id,now,now,input.tickId);
        for (const [index,chunk] of chunks!.entries()) {
          db.prepare("INSERT INTO conversation_participation_primary_chunks (tick_id,chunk_index,content,content_utf8_bytes,content_digest) VALUES (?,?,?,?,?)").run(input.tickId,index,chunk.content,chunk.utf8Bytes,chunk.digest);
          db.prepare("INSERT INTO participant_delivery_chunks (plan_id,chunk_index,content,nonce) VALUES (?,?,?,?)").run(planId,index,chunk.content,createHash("sha256").update(`participation-v2:${input.tickId}:${index}`).digest("hex").slice(0,24));
        }
      }
      if (tick.mode === "apply") {
        const work=db.prepare(`UPDATE participant_event_work SET status=?,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE id=? AND status='claimed' AND claim_holder_id=? AND claim_fence_token=?`).run(needsPlan?"planned":"observe",now,tick.anchor_work_id,input.fence.holderId,input.fence.fenceToken);
        if (work.changes!==1) throw new Error("stale primary work claim");
      }
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  completeParticipationValidation(tickId:string, output:ParticipationValidationOutput, fence:Fence): "applied"|"accepted_shadow"|"idempotent"|"stale" {
    if (!Number.isFinite(output.missedOpportunity) || output.missedOpportunity < 0 || output.missedOpportunity > 1
      || !Number.isFinite(output.interruption) || output.interruption < 0 || output.interruption > 1
      || !Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1
      || !Number.isFinite(output.priorDelta) || output.priorDelta < -0.05 || output.priorDelta > 0.05
      || Buffer.byteLength(output.rationale, "utf8") !== output.rationaleUtf8Bytes || output.rationaleUtf8Bytes > 2_000) {
      throw new Error("invalid participation validation output");
    }
    const now=this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence,now); const tick=db.prepare("SELECT guild_id,channel_id,mode,persona_revision,primary_contract_version FROM conversation_participation_ticks WHERE id=? AND status='validation_claimed'").get(tickId) as {guild_id:string;channel_id:string;mode:ParticipationMode;persona_revision:string;primary_contract_version:string}|undefined;
      const validation=db.prepare("SELECT status,claim_holder_id,claim_fence_token,claim_expires_at_ms FROM conversation_participation_validations WHERE tick_id=?").get(tickId) as {status:string;claim_holder_id:string|null;claim_fence_token:number|null;claim_expires_at_ms:number|null}|undefined;
      if (validation?.status==="applied"||validation?.status==="accepted_shadow") { db.exec("COMMIT"); return "idempotent"; }
      if (!tick||validation?.status!=="claimed"||validation.claim_holder_id!==fence.holderId||validation.claim_fence_token!==fence.fenceToken||validation.claim_expires_at_ms===null||validation.claim_expires_at_ms<=now) { db.exec("ROLLBACK"); return "stale"; }
      if (tick.mode==="shadow") {
        db.prepare(`UPDATE conversation_participation_validations SET status='accepted_shadow',missed_opportunity=?,interruption=?,confidence=?,prior_delta=?,rationale=?,rationale_utf8_bytes=?,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE tick_id=? AND claim_holder_id=? AND claim_fence_token=?`).run(output.missedOpportunity,output.interruption,output.confidence,output.priorDelta,output.rationale,output.rationaleUtf8Bytes,now,tickId,fence.holderId,fence.fenceToken);
        db.prepare("UPDATE conversation_participation_ticks SET status='validated',updated_at_ms=? WHERE id=?").run(now,tickId); db.exec("COMMIT"); return "accepted_shadow";
      }
      const prior=db.prepare("SELECT value,version FROM conversation_participation_priors WHERE guild_id=? AND channel_id=? AND persona_revision=? AND primary_contract_version=?").get(tick.guild_id,tick.channel_id,tick.persona_revision,tick.primary_contract_version) as {value:number;version:number}|undefined;
      const before=prior?.value??0, version=prior?.version??0, after=Math.max(-.25,Math.min(.25,before+output.priorDelta));
      if (prior) {
        const updated=db.prepare("UPDATE conversation_participation_priors SET value=?,version=?,updated_at_ms=? WHERE guild_id=? AND channel_id=? AND persona_revision=? AND primary_contract_version=? AND version=?").run(after,version+1,now,tick.guild_id,tick.channel_id,tick.persona_revision,tick.primary_contract_version,version);
        if (updated.changes!==1) throw new Error("stale prior version");
      } else db.prepare("INSERT INTO conversation_participation_priors (guild_id,channel_id,persona_revision,primary_contract_version,value,version,updated_at_ms) VALUES (?,?,?,?,?,?,?)").run(tick.guild_id,tick.channel_id,tick.persona_revision,tick.primary_contract_version,after,1,now);
      const done=db.prepare(`UPDATE conversation_participation_validations SET status='applied',missed_opportunity=?,interruption=?,confidence=?,prior_delta=?,rationale=?,rationale_utf8_bytes=?,prior_before=?,prior_after=?,prior_version_before=?,prior_version_after=?,claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=? WHERE tick_id=? AND status='claimed' AND claim_holder_id=? AND claim_fence_token=?`).run(output.missedOpportunity,output.interruption,output.confidence,output.priorDelta,output.rationale,output.rationaleUtf8Bytes,before,after,version,version+1,now,tickId,fence.holderId,fence.fenceToken);
      if (!done.changes) throw new Error("stale validation claim"); db.prepare("UPDATE conversation_participation_ticks SET status='validated',updated_at_ms=? WHERE id=?").run(now,tickId); db.exec("COMMIT"); return "applied";
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  retryParticipationValidation(tickId: string, fence: Fence): boolean {
    const now = this.clock(); const db=this.serviceDb.db; db.exec("BEGIN IMMEDIATE");
    try {
      this.requireFence(fence, now);
      const changed = db.prepare(`UPDATE conversation_participation_validations
        SET status=CASE WHEN attempt_count>=3 THEN 'unavailable' ELSE 'pending' END,
          claim_holder_id=NULL,claim_fence_token=NULL,claim_expires_at_ms=NULL,updated_at_ms=?
        WHERE tick_id=? AND status='claimed' AND claim_holder_id=? AND claim_fence_token=? AND ${this.fencedWhere()}`)
        .run(now, tickId, fence.holderId, fence.fenceToken, ...this.fencedArgs(fence,now));
      if (changed.changes !== 1) { db.exec("COMMIT"); return false; }
      const tick=db.prepare(`UPDATE conversation_participation_ticks SET status=CASE
        WHEN (SELECT status FROM conversation_participation_validations WHERE tick_id=?)='unavailable' THEN 'validation_unavailable'
        ELSE 'decided' END,updated_at_ms=? WHERE id=? AND status='validation_claimed' AND ${this.fencedWhere()}`)
        .run(tickId, now, tickId, ...this.fencedArgs(fence,now));
      if (tick.changes !== 1) { db.exec("ROLLBACK"); return false; }
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  participationTick(scope: Scope): { readonly id: string; readonly mode: ParticipationMode; readonly status: string; readonly snapshotJson: string; readonly personaText: string; readonly personaRevision: string; readonly primaryResultJson: string | null; readonly deliveryDisposition: "pending" | "delivered" | "retryable" | "cancelled" | "not_applicable" | null } | null {
    const row = this.serviceDb.db.prepare(`SELECT id,mode,status,snapshot_json,persona_text,persona_revision,primary_result_json,delivery_disposition FROM conversation_participation_ticks WHERE guild_id=? AND channel_id=? AND status NOT IN ('primary_invalid','primary_unavailable','context_truncated','snapshot_corrupt','validated','validation_unavailable','corrupt','aborted') ORDER BY created_at_ms,id LIMIT 1`).get(scope.guildId, scope.channelId) as { id:string; mode:ParticipationMode; status:string; snapshot_json:string; persona_text:string; persona_revision:string; primary_result_json:string|null; delivery_disposition:"pending"|"delivered"|"retryable"|"cancelled"|"not_applicable"|null } | undefined;
    return row ? { id:row.id, mode:row.mode, status:row.status, snapshotJson:row.snapshot_json, personaText:row.persona_text, personaRevision:row.persona_revision, primaryResultJson:row.primary_result_json, deliveryDisposition:row.delivery_disposition } : null;
  }
  participationPrior(scope: Scope, personaRevision: string, primaryContractVersion: string): number {
    const row = this.serviceDb.db.prepare("SELECT value FROM conversation_participation_priors WHERE guild_id=? AND channel_id=? AND persona_revision=? AND primary_contract_version=?").get(scope.guildId,scope.channelId,personaRevision,primaryContractVersion) as { value:number }|undefined;
    return row?.value ?? 0;
  }
  createParticipationDeliveryPlan(input: { readonly tickId:string; readonly workId:string; readonly scope:Scope; readonly chunks:readonly string[]; readonly fence:Fence }): string | null {
    const chunks = input.chunks.map((content) => ({ content, ...verifyCanonicalContent(content, Buffer.byteLength(content, "utf8"), createHash("sha256").update(content, "utf8").digest("hex"), 1, PRIMARY_CHUNK_BYTES_MAX, "primary chunk") }));
    const now=this.clock(); this.requireFence(input.fence,now); const id=`participation:${input.tickId}`;
    this.serviceDb.db.exec("BEGIN IMMEDIATE");
    try {
      const existing=this.serviceDb.db.prepare("SELECT id FROM participant_delivery_plans WHERE tick_id=?").get(input.tickId) as {id:string}|undefined;
      if (!existing) {
        this.serviceDb.db.prepare("INSERT INTO participant_delivery_plans (id,work_id,guild_id,channel_id,status,created_at_ms,updated_at_ms,decision_version,tick_id) VALUES (?,?,?,?, 'pending',?,?, 'v2',?)").run(id,input.workId,input.scope.guildId,input.scope.channelId,now,now,input.tickId);
        for (const [index,chunk] of chunks.entries()) this.serviceDb.db.prepare("INSERT INTO participant_delivery_chunks (plan_id,chunk_index,content,nonce) VALUES (?,?,?,?)").run(id,index,chunk.content,createHash("sha256").update(`participation-v2:${input.tickId}:${index}`).digest("hex").slice(0,24));
      }
      this.serviceDb.db.exec("COMMIT"); return existing?.id ?? id;
    } catch (error) { this.serviceDb.db.exec("ROLLBACK"); throw error; }
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
      const v2Tick = this.serviceDb.db.prepare(`SELECT delivery_disposition FROM conversation_participation_ticks
        WHERE id=(SELECT tick_id FROM participant_delivery_plans WHERE id=? AND decision_version='v2')`).get(planId) as { delivery_disposition: string } | undefined;
      if (v2Tick?.delivery_disposition === "pending") {
        this.serviceDb.db.prepare(`UPDATE conversation_participation_ticks SET delivery_disposition='delivered',updated_at_ms=? WHERE id=(SELECT tick_id FROM participant_delivery_plans WHERE id=? AND decision_version='v2') AND delivery_disposition='pending' AND ${this.fencedWhere()}`)
          .run(now, planId, ...this.fencedArgs(fence, now));
      }
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
      const v2 = this.serviceDb.db.prepare("SELECT t.delivery_disposition FROM participant_delivery_plans p JOIN conversation_participation_ticks t ON t.id=p.tick_id WHERE p.id=? AND p.decision_version='v2'").get(planId) as { delivery_disposition: string } | undefined;
      const disposition = v2?.delivery_disposition === "pending"
        ? this.serviceDb.db.prepare(`UPDATE conversation_participation_ticks SET delivery_disposition=?,updated_at_ms=? WHERE id=(SELECT tick_id FROM participant_delivery_plans WHERE id=? AND decision_version='v2') AND delivery_disposition='pending' AND ${this.fencedWhere()}`).run(status,now,planId,...args)
        : null;
      if (!work || work.changes !== 1 || (v2?.delivery_disposition === "pending" && (!disposition || disposition.changes !== 1))) { this.serviceDb.db.exec("ROLLBACK"); return false; } this.serviceDb.db.exec("COMMIT"); return true;
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
  private corruptParticipationTickIds(scope: Scope): readonly string[] {
    const ticks=this.serviceDb.db.prepare(`SELECT id,snapshot_json,snapshot_utf8_bytes,snapshot_digest,persona_text,persona_utf8_bytes,persona_digest,
      primary_result_json,primary_result_utf8_bytes,primary_result_digest FROM conversation_participation_ticks
      WHERE guild_id=? AND channel_id=? AND status NOT IN ('validated','validation_unavailable','corrupt','aborted')`)
      .all(scope.guildId,scope.channelId) as {id:string;snapshot_json:string;snapshot_utf8_bytes:number;snapshot_digest:string;persona_text:string;persona_utf8_bytes:number;persona_digest:string;primary_result_json:string|null;primary_result_utf8_bytes:number|null;primary_result_digest:string|null}[];
    const corrupt: string[]=[];
    for (const tick of ticks) try {
      verifyCanonicalContent(tick.snapshot_json,tick.snapshot_utf8_bytes,tick.snapshot_digest,2,SNAPSHOT_BYTES_MAX,"snapshot");
      verifyCanonicalContent(tick.persona_text,tick.persona_utf8_bytes,tick.persona_digest,1,PERSONA_BYTES_MAX,"persona");
      if (tick.primary_result_json !== null || tick.primary_result_utf8_bytes !== null || tick.primary_result_digest !== null) {
        if (tick.primary_result_json === null || tick.primary_result_utf8_bytes === null || tick.primary_result_digest === null) throw new Error("incomplete primary result");
        verifyCanonicalContent(tick.primary_result_json,tick.primary_result_utf8_bytes,tick.primary_result_digest,1,PRIMARY_RESULT_BYTES_MAX,"primary result");
      }
      const turns=this.serviceDb.db.prepare("SELECT content,content_utf8_bytes,content_digest FROM conversation_participation_snapshot_turns WHERE tick_id=?").all(tick.id) as {content:string;content_utf8_bytes:number;content_digest:string}[];
      const chunks=this.serviceDb.db.prepare("SELECT content,content_utf8_bytes,content_digest FROM conversation_participation_primary_chunks WHERE tick_id=?").all(tick.id) as {content:string;content_utf8_bytes:number;content_digest:string}[];
      for (const turn of turns) verifyCanonicalContent(turn.content,turn.content_utf8_bytes,turn.content_digest,0,TURN_BYTES_MAX,"snapshot turn");
      for (const chunk of chunks) verifyCanonicalContent(chunk.content,chunk.content_utf8_bytes,chunk.content_digest,1,PRIMARY_CHUNK_BYTES_MAX,"primary chunk");
    } catch { corrupt.push(tick.id); }
    return corrupt;
  }
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
  private admitBudget(input: { readonly scope: Scope; readonly budget: { readonly key: string; readonly count: number; readonly windowStartMs: number; readonly limit: number } }, now: number): boolean {
    const { budget } = input;
    if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || !Number.isSafeInteger(budget.windowStartMs)) return false;
    const scopeKey = `${input.scope.guildId}:${input.scope.channelId}`;
    const current = this.serviceDb.db.prepare("SELECT count,window_start_ms FROM adaptive_budgets WHERE scope_key=? AND budget_key=?").get(scopeKey, budget.key) as { count: number; window_start_ms: number } | undefined;
    const count = current?.window_start_ms === budget.windowStartMs ? current.count : 0;
    if (!Number.isSafeInteger(count) || count >= budget.limit) return false;
    this.serviceDb.db.prepare(`INSERT INTO adaptive_budgets (scope_key,budget_key,count,window_start_ms,updated_at_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_key,budget_key) DO UPDATE SET count=excluded.count,window_start_ms=excluded.window_start_ms,updated_at_ms=excluded.updated_at_ms`)
      .run(scopeKey, budget.key, count + 1, budget.windowStartMs, now);
    return true;
  }
  private writeBudget(input: OutcomeInput, now: number): void { const budget = input.budget!; this.serviceDb.db.prepare(`INSERT INTO adaptive_budgets (scope_key,budget_key,count,window_start_ms,updated_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope_key,budget_key) DO UPDATE SET count=excluded.count,window_start_ms=excluded.window_start_ms,updated_at_ms=excluded.updated_at_ms`).run(`${input.scope.guildId}:${input.scope.channelId}`, budget.key, budget.count, budget.windowStartMs, now); }
  private writePlan(input: OutcomeInput, now: number): void { const plan=input.plan!; this.serviceDb.db.prepare("INSERT INTO participant_delivery_plans (id,work_id,guild_id,channel_id,status,created_at_ms,updated_at_ms) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(plan.id, plan.workId, input.scope.guildId, input.scope.channelId, now, now); for (const [index, chunk] of plan.chunks.entries()) this.serviceDb.db.prepare("INSERT INTO participant_delivery_chunks (plan_id,chunk_index,content,nonce) VALUES (?, ?, ?, ?)").run(plan.id,index,chunk.content,chunk.nonce); }
}
function parseNotes(value: string): readonly string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((note): note is string => typeof note === "string") : []; } catch { return []; } }

export function createAdaptiveAmbientStore(db: ServiceDatabase, clock?: ServiceClock): AdaptiveAmbientStore { return new AdaptiveAmbientStore(db, clock); }
