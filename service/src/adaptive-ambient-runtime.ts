import { createHash } from "node:crypto";
import {
  isDiscordParticipantScopeAllowed,
  type AmbientAppraisalParseResult,
  type DiscordInboundMessage,
  type DiscordMembershipSnapshot,
  type DiscordParticipantScope,
} from "./adaptive-ambient-contracts.js";
import type { AdaptiveAmbientAppraisalProvider } from "./adaptive-ambient-provider.js";
import { evaluateAmbientDecision } from "./conversation-ambient.js";
import { normalizeDiscordAmbientBubbles } from "./discord-ambient-delivery.js";
import { GENERIC_CONVERSATION_PERSONA } from "./conversation-speech-policy.js";
import { deriveActiveHumanIds } from "./conversation-roster.js";
import type { ServiceDatabase } from "./db.js";
import type { AdaptiveAmbientStore, Fence, ServiceClock } from "./adaptive-ambient-store.js";
import { createActiveWorkClaim, type HeartbeatScheduler } from "./adaptive-ambient-runtime-claim.js";
import type { DiscordParticipantStartupConfig } from "./adaptive-ambient-contracts.js";

type Scope = DiscordParticipantScope;
type RuntimeStatus = "aborted" | "disabled" | "idle" | "invalid" | "lease_unavailable" | "observe" | "planned";
type RelationshipContext = { readonly userId: string; readonly rapport: number; readonly familiarity: number; readonly notes: readonly string[] };

export type AdaptiveAmbientRuntimeOptions = {
  readonly serviceDb: ServiceDatabase;
  readonly store: AdaptiveAmbientStore;
  readonly provider: AdaptiveAmbientAppraisalProvider;
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
const RECENT_CONTEXT_LIMIT = 20;

export function createAdaptiveAmbientRuntime(options: AdaptiveAmbientRuntimeOptions): AdaptiveAmbientRuntime {
  const clock = options.clock ?? Date.now;

  async function run(input: { readonly fence: Fence; readonly signal: AbortSignal }): Promise<RuntimeStatus> {
    const mapping = options.serviceDb.getChannelMapping(options.scope.channelId);
    if (!isDiscordParticipantScopeAllowed(options.startup, options.scope, mapping)) return "disabled";
    if (input.signal.aborted) return "aborted";
    if (!options.store.isFenceCurrent(input.fence)) return "lease_unavailable";
    if (!budgetAvailable(options.store, options.scope, options.budgetPerHour, clock())) return "idle";

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
      let appraisal: AmbientAppraisalParseResult;
      try {
        appraisal = await options.provider.appraise({
          scope: options.scope,
          persona: personaFor(options.serviceDb, beforeProviderMapping?.profileId ?? null, options.globalPersona),
          transcript: context.transcript,
          context: { archiveSummaries: context.archiveSummaries, relationships: context.relationships },
        }, { signal: activeWork.signal });
      } catch {
        appraisal = { kind: "invalid", diagnostic: "provider appraisal failed" };
      }
      if (!activeWork.isCurrent()) return "aborted";
      const afterProviderMapping = options.serviceDb.getChannelMapping(options.scope.channelId);
      if (!isDiscordParticipantScopeAllowed(options.startup, options.scope, afterProviderMapping)) return "disabled";
      if (appraisal.kind === "valid" && appraisal.proposal.confidence < 0.7) {
        appraisal = { kind: "invalid", diagnostic: "provider confidence was below threshold" };
      }
      if (appraisal.kind === "valid" && !relationshipTargetsAuthorized(appraisal.proposal.relationshipProposals, context.transcript, roster)) {
        appraisal = { kind: "invalid", diagnostic: "relationship target was not authenticated by transcript or roster" };
      }

      const state = options.store.state(options.scope);
      const decision = evaluateAmbientDecision({
        appraisal,
        eventId: work.eventId,
        state: state && { ...state, scope: options.scope, updatedAtMs: clock() },
        message: context.event,
        botUserId: options.botUserId,
        roster,
        activeHumanIds: loadActiveHumanIds(options.serviceDb, options.scope, roster, clock()),
        nowMs: clock(),
      });
      const proposal = appraisal.kind === "valid" ? appraisal.proposal : undefined;
      const bubbles = proposal ? normalizeDiscordAmbientBubbles(proposal.chunks) : null;
      const planned = decision.shouldSpeak && !work.observeOnly && bubbles !== null;
      const budget = planned ? nextBudget(options.store, options.scope, clock()) : undefined;
      const result = options.store.recordOutcome({
        fence: input.fence,
        eventId: work.eventId,
        scope: options.scope,
        outcome: decision.audit.outcome === "invalid" ? "invalid" : planned ? "planned" : "observe",
        diagnostic: decision.audit.diagnostic,
        proposal,
        state: decision.driveUpdate && { drive: decision.driveUpdate.drive, version: decision.driveUpdate.version },
        relationships: proposal?.relationshipProposals,
        ...(budget ? { budget } : {}),
        ...(planned ? { plan: planFor(work.id, options.scope, work.eventId, bubbles!) } : {}),
        workId: work.id,
      });
      if (result === "idempotent") return "idle";
      return decision.audit.outcome === "invalid" ? "invalid" : planned ? "planned" : "observe";
    } finally {
      activeWork.stop();
    }
  }

  return { run };
}

function loadContext(db: ServiceDatabase, scope: Scope, eventId: string, now: number): { transcript: readonly DiscordInboundMessage[]; event: DiscordInboundMessage; archiveSummaries: readonly string[]; relationships: readonly RelationshipContext[] } {
  const scopeId = `discord:${scope.guildId}:${scope.channelId}`;
  const rows = db.db.prepare(`SELECT message_id,text,event_ts,author_role,metadata_json FROM conversation_raw_events
    WHERE scope_id=? ORDER BY event_ts DESC,id DESC LIMIT ?`).all(scopeId, RECENT_CONTEXT_LIMIT) as RawRow[];
  const transcript = rows.reverse().map((row) => inbound(row, scope));
  const event = transcript.find((entry) => entry.eventId === eventId) ?? { eventId, scope, authorId: "unknown", authorIsBot: false, content: "", mentions: [], replyTo: null, createdAtMs: now };
  const archiveSummaries = db.db.prepare(`SELECT s.summary FROM conversation_archive_summaries s JOIN conversation_archive_batches b ON b.batch_key=s.batch_key
    WHERE b.scope_id=? AND b.status='completed' ORDER BY s.created_at_ms DESC LIMIT 20`).all(scopeId).map((row) => String((row as { summary: string }).summary));
  const relationships = db.db.prepare("SELECT user_id,rapport,familiarity,notes_json FROM adaptive_relationship_profiles WHERE guild_id=? ORDER BY user_id")
    .all(scope.guildId).map((row) => relationship(row as { user_id: string; rapport: number; familiarity: number; notes_json: string }));
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

function budgetAvailable(store: AdaptiveAmbientStore, scope: Scope, limit: number, now: number): boolean {
  if (!Number.isInteger(limit) || limit <= 0) return false;
  const current = store.budget(scope, BUDGET_KEY); const windowStartMs = hourStart(now);
  return !current || current.windowStartMs !== windowStartMs || current.count < limit;
}
function nextBudget(store: AdaptiveAmbientStore, scope: Scope, now: number) { const windowStartMs = hourStart(now); const current = store.budget(scope, BUDGET_KEY); return { key: BUDGET_KEY, count: current?.windowStartMs === windowStartMs ? current.count + 1 : 1, windowStartMs }; }
function hourStart(now: number): number { return Math.floor(now / 3_600_000) * 3_600_000; }
function planFor(workId: string, scope: Scope, eventId: string, chunks: readonly string[]) { return { id: `ambient:${scope.guildId}:${scope.channelId}:${eventId}`, workId, chunks: chunks.map((content, index) => ({ content, nonce: createHash("sha256").update(`ambient-plan-v1:${scope.guildId}:${scope.channelId}:${eventId}:${index}`).digest("hex").slice(0, 32) })) }; }
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
