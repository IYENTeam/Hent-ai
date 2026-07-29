const DISCORD_SNOWFLAKE_RE = /^[1-9][0-9]{0,19}$/;
const MAX_DISCORD_SNOWFLAKE = (1n << 64n) - 1n;

export const ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS = {
  appraisal: "hent_ai.adaptive_ambient.appraisal.v1",
  participationPrimary: "hent_ai.conversation_participation.primary.v2",
  participationValidator: "hent_ai.conversation_participation.validator.v1",
} as const;

export type DiscordParticipantScope = { readonly guildId: string; readonly channelId: string };
export type DiscordParticipantStartupConfig = { readonly enabled: boolean; readonly allowlist: readonly DiscordParticipantScope[]; readonly diagnostics: readonly string[] };
export type DiscordParticipantChannelMapping = { readonly enabled: boolean | null };
export type AmbientSettings = {
  readonly ambientBudgetPerHour?: number;
  readonly ambientConfidenceFloor?: number;
  readonly ambientIdleDecayTauMs?: number;
  readonly ambientPressureTauMs?: number;
  readonly ambientPityEnabled?: boolean;
};
export type DiscordInboundMessage = {
  readonly eventId: string; readonly scope: DiscordParticipantScope; readonly authorId: string; readonly authorIsBot: boolean;
  readonly content: string; readonly mentions: readonly string[]; readonly replyTo: { readonly messageId: string; readonly authorId: string } | null; readonly createdAtMs: number;
};
export type DiscordMembershipSnapshot = { readonly scope: DiscordParticipantScope; readonly memberIds: readonly string[]; readonly complete: boolean; readonly observedAtMs: number };
export type RelationshipProposal = { readonly userId: string; readonly rapportDelta: number; readonly familiarityDelta: number; readonly notes: readonly string[] };
export type AmbientSilenceRequest = { readonly present: false } | { readonly present: true; readonly intensity: "mild" | "strong" | "moderator" };
export type AmbientAppraisalProposal = {
  readonly schema: typeof ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal; readonly decision: "observe" | "speak";
  readonly desiredDrive: number; readonly confidence: number; readonly chunks: readonly string[]; readonly relationshipProposals: readonly RelationshipProposal[];
  readonly silenceRequest: AmbientSilenceRequest;
};
export type AmbientState = {
  readonly scope: DiscordParticipantScope; readonly drive: number; readonly version: number; readonly updatedAtMs: number;
  readonly pressure?: number; readonly pressureUpdatedAtMs?: number | null;
};
export type AmbientDecisionAudit = {
  readonly eventId: string; readonly scope: DiscordParticipantScope; readonly proposal: AmbientAppraisalProposal | null;
  readonly outcome: "invalid" | "observe" | "planned"; readonly diagnostic: string | null; readonly recordedAtMs: number;
};
export type ParticipantWorkStatus = "pending" | "claimed" | "observe" | "planned" | "delivered" | "retryable" | "failed";
export type ParticipantWork = {
  readonly id: string; readonly eventId: string; readonly scope: DiscordParticipantScope; readonly status: ParticipantWorkStatus; readonly observeOnly: boolean;
  readonly claim: { readonly holderId: string; readonly fenceToken: number; readonly expiresAtMs: number } | null;
};
export type ParticipantDeliveryPlan = {
  readonly id: string; readonly workId: string; readonly scope: DiscordParticipantScope;
  readonly chunks: readonly { readonly index: number; readonly content: string; readonly nonce: string }[]; readonly status: "pending" | "delivered" | "cancelled";
};
export type ChunkReceipt = { readonly planId: string; readonly chunkIndex: number; readonly nonce: string; readonly discordMessageId: string; readonly receivedAtMs: number };
export type AmbientAppraisalParseResult = { readonly kind: "valid"; readonly proposal: AmbientAppraisalProposal } | { readonly kind: "invalid"; readonly diagnostic: string } | { readonly kind: "unavailable"; readonly diagnostic: string };
export type ConversationParticipationDecision = "observe" | "speak";
export type ConversationParticipationJudgmentClass = "definitive" | "borderline";
export type ConversationParticipationPrimaryProposal = {
  readonly schema: typeof ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary;
  readonly decision: ConversationParticipationDecision;
  readonly baselineDecision: ConversationParticipationDecision;
  readonly judgmentClass: ConversationParticipationJudgmentClass;
  readonly semanticMargin: number;
  readonly priorApplied: boolean;
  readonly confidence: number;
  readonly chunks: readonly string[];
};
export type ConversationParticipationValidatorProposal = {
  readonly schema: typeof ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationValidator;
  readonly missedOpportunity: number;
  readonly interruption: number;
  readonly confidence: number;
  readonly priorDelta: number;
  readonly rationale: string;
};
export type ConversationParticipationPrimaryParseResult =
  | { readonly kind: "valid"; readonly proposal: ConversationParticipationPrimaryProposal }
  | { readonly kind: "invalid"; readonly diagnostic: string }
  | { readonly kind: "unavailable"; readonly diagnostic: string };
export type ConversationParticipationValidatorParseResult =
  | { readonly kind: "valid"; readonly proposal: ConversationParticipationValidatorProposal }
  | { readonly kind: "invalid"; readonly diagnostic: string }
  | { readonly kind: "unavailable"; readonly diagnostic: string };

export function parseDiscordParticipantAllowlist(value: string | undefined): DiscordParticipantStartupConfig {
  if (value === undefined) return disabled("HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST is required");
  if (value.length === 0) return disabled("HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST must not be empty");
  const allowlist: DiscordParticipantScope[] = []; const scopes = new Set<string>();
  for (const pair of value.split(",")) {
    const parsed = scopePair(pair);
    if (!parsed) return disabled("HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST must be comma-separated guildId:channelId Snowflake pairs");
    const key = `${parsed.guildId}:${parsed.channelId}`;
    if (scopes.has(key)) return disabled("HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST must not contain duplicate guildId:channelId pairs");
    scopes.add(key); allowlist.push(parsed);
  }
  return { enabled: true, allowlist, diagnostics: [] };
}

export function isDiscordParticipantScopeAllowed(startup: DiscordParticipantStartupConfig, scope: DiscordParticipantScope, channelMapping: DiscordParticipantChannelMapping | null): boolean {
  return startup.enabled && channelMapping?.enabled === true && startup.allowlist.some((candidate) => candidate.guildId === scope.guildId && candidate.channelId === scope.channelId);
}

export function readAmbientSettings(settingsJson: string | null): AmbientSettings {
  if (settingsJson === null) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    return {};
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return {};
  const value = settings as Record<string, unknown>;
  return {
    ...(positiveInteger(value.ambientBudgetPerHour) ? { ambientBudgetPerHour: value.ambientBudgetPerHour } : {}),
    ...(unitInterval(value.ambientConfidenceFloor) ? { ambientConfidenceFloor: value.ambientConfidenceFloor } : {}),
    ...(minimumInteger(value.ambientIdleDecayTauMs, 60_000) ? { ambientIdleDecayTauMs: value.ambientIdleDecayTauMs } : {}),
    ...(minimumInteger(value.ambientPressureTauMs, 60_000) ? { ambientPressureTauMs: value.ambientPressureTauMs } : {}),
    ...(typeof value.ambientPityEnabled === "boolean" ? { ambientPityEnabled: value.ambientPityEnabled } : {}),
  };
}

function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function unitInterval(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function minimumInteger(value: unknown, minimum: number): value is number { return typeof value === "number" && Number.isInteger(value) && value >= minimum; }
function disabled(diagnostic: string): DiscordParticipantStartupConfig { return { enabled: false, allowlist: [], diagnostics: [diagnostic] }; }
function scopePair(value: string): DiscordParticipantScope | null {
  const separator = value.indexOf(":"); if (separator <= 0 || separator !== value.lastIndexOf(":")) return null;
  const guildId = value.slice(0, separator); const channelId = value.slice(separator + 1);
  return snowflake(guildId) && snowflake(channelId) ? { guildId, channelId } : null;
}
function snowflake(value: string): boolean { return DISCORD_SNOWFLAKE_RE.test(value) && BigInt(value) <= MAX_DISCORD_SNOWFLAKE; }

export {
  parseAmbientAppraisalProposal,
  parseConversationParticipationPrimary,
  parseConversationParticipationValidator,
} from "./adaptive-ambient-proposal-parser.js";
