import { createHash } from "node:crypto";
import {
  isDiscordParticipantScopeAllowed,
  readAmbientSettings,
  type AmbientAppraisalParseResult,
  type DiscordInboundMessage,
  type DiscordMembershipSnapshot,
  type DiscordParticipantScope,
} from "./adaptive-ambient-contracts.js";
import type { AdaptiveAmbientAppraisalProvider, ConversationParticipationPrimaryProvider } from "./adaptive-ambient-provider.js";
import type { ConversationParticipationValidator } from "./conversation-participation-validator.js";
import { ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS } from "./adaptive-ambient-contracts.js";
import { canonicalUtf8Bytes, materializeConversationParticipantContext, resolveConversationParticipantPersona, sha256Utf8, stableCanonicalJson, type ConversationParticipantRawEvent } from "./conversation-participant-context.js";
import { applyAmbientIdleDecay, evaluateAmbientDecision, IDLE_DECAY_TAU_MS } from "./conversation-ambient.js";
import { normalizeDiscordAmbientBubbles } from "./discord-ambient-delivery.js";
import { GENERIC_CONVERSATION_PERSONA } from "./conversation-speech-policy.js";
import { deriveActiveHumanIds } from "./conversation-roster.js";
import type { ServiceDatabase } from "./db.js";
import type { AdaptiveAmbientStore, Fence, ServiceClock } from "./adaptive-ambient-store.js";
import { createActiveWorkClaim, type HeartbeatScheduler } from "./adaptive-ambient-runtime-claim.js";
import type { DiscordParticipantStartupConfig } from "./adaptive-ambient-contracts.js";

type Scope = DiscordParticipantScope;
type RuntimeStatus = "aborted" | "disabled" | "idle" | "invalid" | "lease_unavailable" | "observe" | "planned" | "provider_unavailable";
type RelationshipContext = { readonly userId: string; readonly rapport: number; readonly familiarity: number; readonly notes: readonly string[] };

export type AdaptiveAmbientRuntimeOptions = {
  readonly serviceDb: ServiceDatabase;
  readonly store: AdaptiveAmbientStore;
  readonly provider: AdaptiveAmbientAppraisalProvider;
  readonly primary?: ConversationParticipationPrimaryProvider;
  readonly validator?: ConversationParticipationValidator;
  readonly primaryModel?: string;
  readonly validatorModel?: string;
  readonly defaultMode?: "off" | "shadow" | "apply";
  readonly startup: DiscordParticipantStartupConfig;
  readonly scope: Scope;
  readonly botUserId: string;
  readonly budgetPerHour: number;
  readonly globalPersona?: string;
  readonly clock?: ServiceClock;
  readonly scheduleHeartbeat?: HeartbeatScheduler;
  readonly loadRoster: (scope: Scope, signal: AbortSignal) => Promise<DiscordMembershipSnapshot>;
};

export type AdaptiveAmbientRuntime = {
  readonly run: (input: { readonly fence: Fence; readonly signal: AbortSignal }) => Promise<RuntimeStatus>;
};

const BUDGET_KEY = "ambient";
const DEFAULT_AMBIENT_DRIVE = 0.7;
const DEFAULT_AMBIENT_CONFIDENCE_FLOOR = 0.6;
const RECENT_CONTEXT_LIMIT = 50;
const RECENT_CONTEXT_LOOKBACK_DAYS = 15 / (24 * 60);
const ROSTER_FRESHNESS_MS = 5 * 60_000;

export function createAdaptiveAmbientRuntime(options: AdaptiveAmbientRuntimeOptions): AdaptiveAmbientRuntime {
  const clock = options.clock ?? Date.now;

  async function run(input: { readonly fence: Fence; readonly signal: AbortSignal }): Promise<RuntimeStatus> {
    const mapping = options.serviceDb.getChannelMapping(options.scope.channelId);
    if (!isDiscordParticipantScopeAllowed(options.startup, options.scope, mapping)) return "disabled";
    const ambientSettings = readAmbientSettings(channelSettingsJson(options.serviceDb, options.scope.channelId));
    const v2Mode = participationMode(channelSettingsJson(options.serviceDb, options.scope.channelId), options.defaultMode);
    if (v2Mode === "apply") return runParticipationV2(options, input, v2Mode, clock);
    if (v2Mode === "shadow") {
      try { await runParticipationV2(options, input, v2Mode, clock); }
      catch { options.store.recordUnfencedDiagnostic(input.fence, "participation shadow runtime failure"); }
    }
    if (v2Mode === "off") {
      if (!options.store.isFenceCurrent(input.fence)) return "lease_unavailable";
      options.store.recoverExpiredParticipationClaims(options.scope, input.fence);
      const tick = options.store.participationTick(options.scope);
      if (tick?.status === "decided") return validateParticipation(options, input, tick.id, tick.snapshotJson, tick.primaryResultJson, tick.deliveryDisposition);
    }
    if (input.signal.aborted) return "aborted";
    if (!options.store.isFenceCurrent(input.fence)) return "lease_unavailable";
    const budgetLimit = ambientSettings.ambientBudgetPerHour ?? options.budgetPerHour;
    if (input.signal.aborted) return "aborted";
    if (!options.store.isFenceCurrent(input.fence)) return "lease_unavailable";
    if (!budgetAvailable(options.store, options.scope, budgetLimit, clock())) return "idle";

    const workId = options.store.claimNextWork(options.scope, input.fence);
    if (!workId) return "idle";
    const work = options.store.work(workId);
    if (!work || work.status !== "claimed") return "idle";
    if (input.signal.aborted) return "aborted";
    if (!options.store.isFenceCurrent(input.fence)) return "lease_unavailable";

    const activeWork = createActiveWorkClaim(options.store, work.id, input.fence, input.signal, options.scheduleHeartbeat);
    try {
      const context = loadContext(options.serviceDb, options.scope, work.eventId, clock());
      const roster = await loadRoster(options, activeWork.signal, clock());
      if (!activeWork.isCurrent()) return "aborted";
      const afterRosterMapping = options.serviceDb.getChannelMapping(options.scope.channelId);
      if (!isDiscordParticipantScopeAllowed(options.startup, options.scope, afterRosterMapping)) return "disabled";
      if (!options.store.persistMembershipSnapshot(options.scope, roster.memberIds, roster.complete, roster.observedAtMs, input.fence)) return "lease_unavailable";

      const beforeProviderMapping = options.serviceDb.getChannelMapping(options.scope.channelId);
      if (!isDiscordParticipantScopeAllowed(options.startup, options.scope, beforeProviderMapping)) return "disabled";
      if (!activeWork.isCurrent()) return "aborted";
      const now = clock();
      const state = options.store.state(options.scope);
      const activeHumanIds = loadActiveHumanIds(options.serviceDb, options.scope, roster, now);
      let appraisal: AmbientAppraisalParseResult;
      try {
        appraisal = await options.provider.appraise({
          scope: options.scope,
          persona: personaFor(options.serviceDb, beforeProviderMapping?.profileId ?? null, options.globalPersona),
          transcript: context.transcript,
          context: { archiveSummaries: context.archiveSummaries, relationships: context.relationships },
          audience: {
            rosterComplete: roster.complete,
            currentDrive: state?.drive ?? DEFAULT_AMBIENT_DRIVE,
            budgetRemaining: budgetRemaining(options.store, options.scope, budgetLimit, now),
          },
        }, { signal: activeWork.signal });
      } catch {
        appraisal = { kind: "unavailable", diagnostic: "provider appraisal failed" };
      }
      if (!activeWork.isCurrent()) return "aborted";
      const afterProviderMapping = options.serviceDb.getChannelMapping(options.scope.channelId);
      if (!isDiscordParticipantScopeAllowed(options.startup, options.scope, afterProviderMapping)) return "disabled";
      if (appraisal.kind === "unavailable") return "provider_unavailable";
      if (appraisal.kind === "valid" && appraisal.proposal.confidence < (ambientSettings.ambientConfidenceFloor ?? DEFAULT_AMBIENT_CONFIDENCE_FLOOR)) {
        appraisal = { kind: "invalid", diagnostic: "provider confidence was below threshold" };
      }
      if (appraisal.kind === "valid" && !relationshipTargetsAuthorized(appraisal.proposal.relationshipProposals, context.transcript, roster)) {
        appraisal = { kind: "invalid", diagnostic: "relationship target was not authenticated by transcript or roster" };
      }

      const decision = evaluateAmbientDecision({
        appraisal,
        eventId: work.eventId,
        state: state && { ...state, scope: options.scope },
        message: context.event,
        botUserId: options.botUserId,
        roster,
        nowMs: now,
        observeOnly: work.observeOnly,
        ambientPityEnabled: ambientSettings.ambientPityEnabled ?? true,
        confidenceFloor: ambientSettings.ambientConfidenceFloor ?? DEFAULT_AMBIENT_CONFIDENCE_FLOOR,
        idleDecayTauMs: ambientSettings.ambientIdleDecayTauMs,
        pressureTauMs: ambientSettings.ambientPressureTauMs,
      });
      const proposal = appraisal.kind === "valid" ? appraisal.proposal : undefined;
      const bubbles = proposal ? normalizeDiscordAmbientBubbles(proposal.chunks) : null;
      const planned = decision.shouldSpeak && !work.observeOnly && bubbles !== null;
      const budget = planned ? nextBudget(options.store, options.scope, clock()) : undefined;
      const driveBefore = decision.driveUpdate === null ? null : state === null ? DEFAULT_AMBIENT_DRIVE
        : applyAmbientIdleDecay(state.drive, state.updatedAtMs, now, ambientSettings.ambientIdleDecayTauMs ?? IDLE_DECAY_TAU_MS);
      const result = options.store.recordOutcome({
        fence: input.fence,
        eventId: work.eventId,
        scope: options.scope,
        outcome: decision.audit.outcome === "invalid" ? "invalid" : planned ? "planned" : "observe",
        diagnostic: decision.audit.diagnostic,
        proposal,
        auditEvidence: {
          evidenceWeight: decision.evidenceWeight,
          probability: decision.probability,
          draw: decision.draw,
          driveBefore,
          driveAfter: decision.driveUpdate?.drive ?? null,
          activeHumanCount: activeHumanIds.length,
          rosterFresh: isFreshCompleteRoster(roster, now),
        },
        state: decision.driveUpdate && {
          drive: decision.driveUpdate.drive,
          version: decision.driveUpdate.version,
          pressure: decision.driveUpdate.pressure,
          pressureUpdatedAtMs: decision.driveUpdate.pressureUpdatedAtMs,
          speakStreak: decision.driveUpdate.speakStreak,
          skipStreak: decision.driveUpdate.skipStreak,
        },
        relationships: proposal?.relationshipProposals,
        ...(budget ? { budget } : {}),
        ...(planned ? { plan: planFor(work.id, options.scope, work.eventId, bubbles!) } : {}),
        workId: work.id,
        batchHighWatermark: { createdAtMs: work.createdAtMs, workId: work.id },
      });
      if (result === "idempotent") return "idle";
      return decision.audit.outcome === "invalid" ? "invalid" : planned ? "planned" : "observe";
    } finally {
      activeWork.stop();
    }
  }

  return { run };
}

async function runParticipationV2(options: AdaptiveAmbientRuntimeOptions, input: { readonly fence: Fence; readonly signal: AbortSignal }, mode: "apply" | "shadow", clock: ServiceClock): Promise<RuntimeStatus> {
  if (!options.primary || !options.validator || input.signal.aborted || !options.store.isFenceCurrent(input.fence)) return input.signal.aborted ? "aborted" : "provider_unavailable";
  const primaryModel = options.primaryModel?.trim();
  const validatorModel = options.validatorModel?.trim();
  if (!primaryModel || !validatorModel || (mode === "apply" && primaryModel === validatorModel)) return "provider_unavailable";
  options.store.recoverExpiredParticipationClaims(options.scope, input.fence);
  let tick = options.store.participationTick(options.scope);
  if (tick?.status === "decided") return validateParticipation(options, input, tick.id, tick.snapshotJson, tick.primaryResultJson, tick.deliveryDisposition);
  if (!tick) {
    const scopeId = `discord:${options.scope.guildId}:${options.scope.channelId}`;
    const highWatermark = options.serviceDb.db.prepare("SELECT MAX(id) AS id FROM conversation_raw_events WHERE scope_id=?").get(scopeId) as { id: number | null };
    if (highWatermark.id !== null) options.store.terminalizeParticipationObserveOnly(options.scope, highWatermark.id, input.fence);
    if (mode === "apply") {
      const budgetLimit = readAmbientSettings(channelSettingsJson(options.serviceDb, options.scope.channelId)).ambientBudgetPerHour ?? options.budgetPerHour;
      if (!budgetAvailable(options.store, options.scope, budgetLimit, clock())) return "idle";
    }
    const rows = options.serviceDb.db.prepare(`SELECT w.id,w.event_id AS eventId FROM participant_event_work w JOIN conversation_raw_events r ON r.message_id=w.event_id
      WHERE w.guild_id=? AND w.channel_id=? AND w.participation_tick_id IS NULL
        AND (w.status IN ('pending','retryable') OR (w.status='claimed' AND w.claim_expires_at_ms<=?))
        AND w.observe_only=0 AND r.scope_id=? AND r.author_source='discord-participant' AND r.author_role='user'
        AND NOT EXISTS (SELECT 1 FROM conversation_participation_coverage c WHERE c.work_id=w.id AND c.coverage_kind=?)
      ORDER BY w.created_at_ms DESC,w.id DESC LIMIT 120`).all(options.scope.guildId, options.scope.channelId, clock(), scopeId, mode) as { id:string; eventId:string }[];
    if (!rows.length) return "idle";
    const raw = options.serviceDb.db.prepare(`SELECT * FROM (SELECT id,scope_id AS scopeId,message_id AS messageId,author_source AS authorSource,
      author_role AS authorRole,text,event_ts AS eventTs,metadata_json AS metadataJson FROM conversation_raw_events
      WHERE scope_id=? ORDER BY id DESC LIMIT 97) ORDER BY id`).all(scopeId) as ConversationParticipantRawEvent[];
    const anchorWork = rows[0]!;
    const materialized = materializeConversationParticipantContext(scopeId, raw, anchorWork.eventId);
    if (materialized.kind !== "valid") {
      options.store.terminalizeParticipationInvalidContext(options.scope, anchorWork.id, materialized.kind, input.fence);
      return "invalid";
    }
    const mapping = options.serviceDb.getChannelMapping(options.scope.channelId);
    const persona = resolveConversationParticipantPersona({ profile: mapping?.profileId ? options.serviceDb.getProfile(mapping.profileId) ?? null : null, configuredGlobalPersona: options.globalPersona });
    if (!persona || !isParticipationCurrent(options, input, mode)) return "invalid";
    const id = `participation:${options.scope.guildId}:${options.scope.channelId}:${materialized.snapshot.digest}`;
    if (!options.store.bindParticipationTick({ id, scope: options.scope, mode, primaryContractVersion: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary, anchorWorkId: anchorWork.id, snapshot: { highWatermarkId: materialized.snapshot.highWatermarkId, json: materialized.snapshot.canonicalJson, utf8Bytes: materialized.snapshot.utf8Bytes, digest: materialized.snapshot.digest, turns: materialized.snapshot.turns.map((turn) => ({ rawEventId: turn.id, content: turn.text, utf8Bytes: Buffer.byteLength(turn.text), digest: sha256Utf8(turn.text)! })) }, persona, coverageWorkIds: rows.map((row) => row.id), fence: input.fence })) return "idle";
    tick = options.store.participationTick(options.scope);
    if (!tick) return "idle";
  }
  if (!isParticipationCurrent(options, input, mode)) {
    options.store.abortParticipationTick(tick.id, "explicit_predecision", input.fence);
    return "aborted";
  }
  if (!options.store.claimParticipationPrimary(tick.id, input.fence)) return "idle";
  const snapshot = JSON.parse(tick.snapshotJson) as { turns: import("./conversation-participant-context.js").ConversationParticipantTurn[] };
  let response;
  try { response = await options.primary.decide({ persona: tick.personaText, turns: snapshot.turns, prior: { speak: options.store.participationPrior(options.scope, tick.personaRevision, ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary), observe: 0 } }, { signal: input.signal }); }
  catch { response = { kind: "unavailable", diagnostic: "primary provider failed" } as const; }
  if (!isParticipationCurrent(options, input, mode)) {
    options.store.abortParticipationTick(tick.id, "explicit_predecision", input.fence);
    return "aborted";
  }
  if (response.kind !== "valid") {
    options.store.failParticipationPrimary(tick.id, response.kind === "invalid" ? "invalid" : "unavailable", input.fence);
    return "invalid";
  }
  const json = stableCanonicalJson(response.proposal);
  const bytes = json === null ? null : canonicalUtf8Bytes(json);
  const digest = json === null ? null : sha256Utf8(json);
  const now = clock();
  const budgetLimit = readAmbientSettings(channelSettingsJson(options.serviceDb, options.scope.channelId)).ambientBudgetPerHour ?? options.budgetPerHour;
  const currentBudget = options.store.budget(options.scope, BUDGET_KEY);
  const windowStartMs = hourStart(now);
  const budget = mode === "apply" && response.proposal.decision === "speak"
    ? { key: BUDGET_KEY, count: currentBudget?.windowStartMs === windowStartMs ? currentBudget.count + 1 : 1, windowStartMs, limit: budgetLimit }
    : undefined;
  const anchorWorkId = (options.serviceDb.db.prepare("SELECT anchor_work_id FROM conversation_participation_ticks WHERE id=?").get(tick.id) as { anchor_work_id: string }).anchor_work_id;
  if (json === null || bytes === null || digest === null) {
    options.store.failParticipationPrimary(tick.id, "invalid", input.fence);
    return "invalid";
  }
  const persisted = options.store.persistParticipationPrimary({
    tickId: tick.id,
    fence: input.fence,
    resultJson: json,
    resultUtf8Bytes: bytes,
    resultDigest: digest,
    decision: response.proposal.decision,
    validationSchemaVersion: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationValidator,
    validatorModel: validatorModel!,
    chunks: response.proposal.chunks,
    workId: anchorWorkId,
    scope: options.scope,
    ...(budget ? { budget } : {}),
  });
  if (!persisted) return "idle";
  return response.proposal.decision === "speak" ? "planned" : "observe";
}
async function validateParticipation(options: AdaptiveAmbientRuntimeOptions, input: { readonly fence: Fence; readonly signal: AbortSignal }, tickId: string, snapshotJson: string, primaryJson: string | null, disposition: "pending" | "delivered" | "retryable" | "cancelled" | "not_applicable" | null): Promise<RuntimeStatus> {
  if (!options.validator || !primaryJson || disposition === "pending" || !isPostdecisionCurrent(options, input) || !options.store.claimParticipationValidation(tickId, input.fence)) return "idle";
  const snapshot = JSON.parse(snapshotJson) as { turns: import("./conversation-participant-context.js").ConversationParticipantTurn[] };
  let result;
  try { result = await options.validator.validate({ turns: snapshot.turns, primary: JSON.parse(primaryJson), firstDeliveryDisposition: disposition ?? "not_applicable" }, { signal: input.signal }); }
  catch {
    options.store.retryParticipationValidation(tickId, input.fence);
    return "provider_unavailable";
  }
  if (!isPostdecisionCurrent(options, input)) return "aborted";
  if (result.kind !== "valid") {
    options.store.retryParticipationValidation(tickId, input.fence);
    return "provider_unavailable";
  }
  const rationaleUtf8Bytes = canonicalUtf8Bytes(result.proposal.rationale);
  if (rationaleUtf8Bytes === null || !isPostdecisionCurrent(options, input)) return "invalid";
  options.store.completeParticipationValidation(tickId, { ...result.proposal, rationaleUtf8Bytes }, input.fence);
  return "observe";
}
function participationMode(settings: string | null, fallback: "off" | "shadow" | "apply" = "off"): "off" | "shadow" | "apply" {
  try {
    const value = JSON.parse(settings ?? "{}") as Record<string, unknown>;
    if (!Object.hasOwn(value, "conversationParticipationMode")) return fallback;
    return value.conversationParticipationMode === "off" || value.conversationParticipationMode === "shadow" || value.conversationParticipationMode === "apply"
      ? value.conversationParticipationMode
      : "off";
  } catch { return "off"; }
}
function isParticipationCurrent(options: AdaptiveAmbientRuntimeOptions, input: { readonly fence: Fence; readonly signal: AbortSignal }, mode?: "apply" | "shadow"): boolean {
  return !input.signal.aborted
    && options.store.isFenceCurrent(input.fence)
    && isDiscordParticipantScopeAllowed(options.startup, options.scope, options.serviceDb.getChannelMapping(options.scope.channelId))
    && (mode === undefined || participationMode(channelSettingsJson(options.serviceDb, options.scope.channelId), options.defaultMode) === mode);
}
function isPostdecisionCurrent(options: AdaptiveAmbientRuntimeOptions, input: { readonly fence: Fence; readonly signal: AbortSignal }): boolean {
  return !input.signal.aborted && options.store.isFenceCurrent(input.fence);
}
function loadContext(db: ServiceDatabase, scope: Scope, eventId: string, now: number): { transcript: readonly DiscordInboundMessage[]; event: DiscordInboundMessage; archiveSummaries: readonly string[]; relationships: readonly RelationshipContext[] } {
  const scopeId = `discord:${scope.guildId}:${scope.channelId}`;
  const rows = db.db.prepare(`WITH target AS (
      SELECT julianday(event_ts) AS event_jd FROM conversation_raw_events WHERE scope_id=? AND message_id=? LIMIT 1
    )
    SELECT r.message_id,r.text,r.event_ts,r.author_role,r.metadata_json FROM conversation_raw_events r,target
    WHERE r.scope_id=? AND julianday(r.event_ts) BETWEEN target.event_jd-? AND target.event_jd
    ORDER BY r.event_ts DESC,r.id DESC LIMIT ?`).all(scopeId, eventId, scopeId, RECENT_CONTEXT_LOOKBACK_DAYS, RECENT_CONTEXT_LIMIT) as RawRow[];
  const transcript = rows.reverse().map((row) => inbound(row, scope));
  const event = transcript.find((entry) => entry.eventId === eventId) ?? { eventId, scope, authorId: "unknown", authorIsBot: false, content: "", mentions: [], replyTo: null, createdAtMs: now };
  const archiveSummaries = db.db.prepare(`SELECT s.summary FROM conversation_archive_summaries s JOIN conversation_archive_batches b ON b.batch_key=s.batch_key
    WHERE b.scope_id=? AND b.status='completed' ORDER BY s.created_at_ms DESC LIMIT 20`).all(scopeId).map((row) => String((row as { summary: string }).summary));
  const relationships = db.db.prepare("SELECT user_id,rapport,familiarity,notes_json FROM adaptive_relationship_profiles WHERE guild_id=? AND channel_id=? ORDER BY user_id")
    .all(scope.guildId, scope.channelId).map((row) => relationship(row as { user_id: string; rapport: number; familiarity: number; notes_json: string }));
  return { transcript, event, archiveSummaries, relationships };
}

type RawRow = { readonly message_id: string; readonly text: string; readonly event_ts: string; readonly author_role: string; readonly metadata_json: string };
function inbound(row: RawRow, scope: Scope): DiscordInboundMessage {
  const metadata = parseRecord(row.metadata_json);
  const reply = metadata.replyTo;
  const replyTo = isReplyMetadata(reply) ? { messageId: reply.messageId, authorId: reply.authorId } : null;
  return { eventId: row.message_id, scope, authorId: stringValue(metadata.discordAuthorId), authorIsBot: metadata.discordAuthorBot === true || row.author_role === "assistant",
    content: row.text, mentions: stringList(metadata.mentions), replyTo,
    createdAtMs: Number.isFinite(Date.parse(row.event_ts)) ? Date.parse(row.event_ts) : 0 };
}

async function loadRoster(options: AdaptiveAmbientRuntimeOptions, signal: AbortSignal, now: number): Promise<DiscordMembershipSnapshot> {
  try {
    return await options.loadRoster(options.scope, signal);
  } catch {
    return { scope: options.scope, memberIds: [], complete: false, observedAtMs: now };
  }
}

function relationshipTargetsAuthorized(
  proposals: readonly { readonly userId: string }[],
  transcript: readonly DiscordInboundMessage[],
  roster: DiscordMembershipSnapshot,
): boolean {
  const authenticated = new Set([...transcript.map((entry) => entry.authorId), ...roster.memberIds]);
  return proposals.every((proposal) => authenticated.has(proposal.userId));
}

function loadActiveHumanIds(db: ServiceDatabase, scope: Scope, roster: DiscordMembershipSnapshot, now: number): readonly string[] {
  const scopeId = `discord:${scope.guildId}:${scope.channelId}`;
  const rows = db.db.prepare(`SELECT event_ts,author_role,metadata_json FROM conversation_raw_events
    WHERE scope_id=? AND author_source='discord-participant' AND event_ts>=? AND event_ts<=? ORDER BY id`)
    .all(scopeId, new Date(now - 600_000).toISOString(), new Date(now).toISOString()) as { event_ts: string; author_role: string; metadata_json: string }[];
  return deriveActiveHumanIds(roster, rows.map((row) => {
    const metadata = parseRecord(row.metadata_json);
    return { authorId: stringValue(metadata.discordAuthorId), authorIsBot: row.author_role !== "user" || metadata.discordAuthorBot === true, createdAtMs: Date.parse(row.event_ts) };
  }), now);
}

function channelSettingsJson(db: ServiceDatabase, channelId: string): string | null {
  const row = db.db.prepare("SELECT settings_json FROM channel_settings WHERE channel_id=?").get(channelId) as { readonly settings_json: string | null } | undefined;
  return row?.settings_json ?? null;
}

function isFreshCompleteRoster(roster: DiscordMembershipSnapshot, now: number): boolean {
  return Number.isFinite(now) && roster.complete && Number.isFinite(roster.observedAtMs)
    && now >= roster.observedAtMs && now - roster.observedAtMs <= ROSTER_FRESHNESS_MS;
}

function budgetAvailable(store: AdaptiveAmbientStore, scope: Scope, limit: number, now: number): boolean {
  if (!Number.isInteger(limit) || limit <= 0) return false;
  return budgetRemaining(store, scope, limit, now) > 0;
}
function budgetRemaining(store: AdaptiveAmbientStore, scope: Scope, limit: number, now: number): number {
  const current = store.budget(scope, BUDGET_KEY); const windowStartMs = hourStart(now);
  return !current || current.windowStartMs !== windowStartMs ? limit : Math.max(0, limit - current.count);
}
function nextBudget(store: AdaptiveAmbientStore, scope: Scope, now: number) { const windowStartMs = hourStart(now); const current = store.budget(scope, BUDGET_KEY); return { key: BUDGET_KEY, count: current?.windowStartMs === windowStartMs ? current.count + 1 : 1, windowStartMs }; }
function hourStart(now: number): number { return Math.floor(now / 3_600_000) * 3_600_000; }
function planFor(workId: string, scope: Scope, eventId: string, chunks: readonly string[]) { return { id: `ambient:${scope.guildId}:${scope.channelId}:${eventId}`, workId, chunks: chunks.map((content, index) => ({ content, nonce: createHash("sha256").update(`ambient-plan-v1:${scope.guildId}:${scope.channelId}:${eventId}:${index}`).digest("hex").slice(0, 24) })) }; }
function personaFor(db: ServiceDatabase, profileId: string | null, globalPersona: string | undefined): string { return db.getProfile(profileId ?? "")?.soulSnippet?.trim() || globalPersona?.trim() || GENERIC_CONVERSATION_PERSONA; }
function relationship(row: { user_id: string; rapport: number; familiarity: number; notes_json: string }): RelationshipContext { return { userId: row.user_id, rapport: row.rapport, familiarity: row.familiarity, notes: parseStringList(row.notes_json) }; }
function parseRecord(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function parseStringList(value: string): readonly string[] { try { return stringList(JSON.parse(value)); } catch { return []; } }
function isReplyMetadata(value: unknown): value is { readonly messageId: string; readonly authorId: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as { readonly messageId?: unknown; readonly authorId?: unknown };
  return typeof reply.messageId === "string" && reply.messageId.length > 0 && typeof reply.authorId === "string" && reply.authorId.length > 0;
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringList(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
