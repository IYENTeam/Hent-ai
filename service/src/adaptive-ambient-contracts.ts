const DISCORD_SNOWFLAKE_RE = /^[1-9][0-9]{0,19}$/;
const MAX_DISCORD_SNOWFLAKE = (1n << 64n) - 1n;

export const ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS = { appraisal: "hent_ai.adaptive_ambient.appraisal.v1" } as const;

export type DiscordParticipantScope = { readonly guildId: string; readonly channelId: string };
export type DiscordParticipantStartupConfig = { readonly enabled: boolean; readonly allowlist: readonly DiscordParticipantScope[]; readonly diagnostics: readonly string[] };
export type DiscordParticipantChannelMapping = { readonly enabled: boolean | null };
export type DiscordInboundMessage = {
  readonly eventId: string; readonly scope: DiscordParticipantScope; readonly authorId: string; readonly authorIsBot: boolean;
  readonly content: string; readonly mentions: readonly string[]; readonly replyTo: { readonly messageId: string; readonly authorId: string } | null; readonly createdAtMs: number;
};
export type DiscordMembershipSnapshot = { readonly scope: DiscordParticipantScope; readonly memberIds: readonly string[]; readonly complete: boolean; readonly observedAtMs: number };
export type RelationshipProposal = { readonly userId: string; readonly rapportDelta: number; readonly familiarityDelta: number; readonly notes: readonly string[] };
export type AmbientAppraisalProposal = {
  readonly schema: typeof ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal; readonly decision: "observe" | "speak";
  readonly desiredDrive: number; readonly confidence: number; readonly chunks: readonly string[]; readonly relationshipProposals: readonly RelationshipProposal[];
};
export type AmbientState = { readonly scope: DiscordParticipantScope; readonly drive: number; readonly version: number; readonly updatedAtMs: number };
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
export type AmbientAppraisalParseResult = { readonly kind: "valid"; readonly proposal: AmbientAppraisalProposal } | { readonly kind: "invalid"; readonly diagnostic: string };

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

function disabled(diagnostic: string): DiscordParticipantStartupConfig { return { enabled: false, allowlist: [], diagnostics: [diagnostic] }; }
function scopePair(value: string): DiscordParticipantScope | null {
  const separator = value.indexOf(":"); if (separator <= 0 || separator !== value.lastIndexOf(":")) return null;
  const guildId = value.slice(0, separator); const channelId = value.slice(separator + 1);
  return snowflake(guildId) && snowflake(channelId) ? { guildId, channelId } : null;
}
function snowflake(value: string): boolean { return DISCORD_SNOWFLAKE_RE.test(value) && BigInt(value) <= MAX_DISCORD_SNOWFLAKE; }

export { parseAmbientAppraisalProposal } from "./adaptive-ambient-proposal-parser.js";
