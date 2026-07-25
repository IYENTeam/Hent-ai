import { createHash } from "node:crypto";

import type {
  AmbientAppraisalParseResult,
  AmbientAppraisalProposal,
  AmbientDecisionAudit,
  AmbientState,
  DiscordInboundMessage,
  DiscordMembershipSnapshot,
} from "./adaptive-ambient-contracts.js";

const DEFAULT_DRIVE = 0.5;
const ROSTER_FRESHNESS_MS = 5 * 60 * 1000;
const DRAW_DENOMINATOR = 2 ** 53;

export type AmbientEvidenceInput = {
  readonly message: Pick<DiscordInboundMessage, "mentions" | "replyTo">;
  readonly botUserId: string;
  readonly roster: DiscordMembershipSnapshot;
  readonly activeHumanIds: readonly string[];
  readonly nowMs: number;
};

export type AmbientProbabilityInput = {
  readonly decision: AmbientAppraisalProposal["decision"];
  readonly validChunks: boolean;
  readonly nextDrive: number;
  readonly confidence: number;
  readonly evidenceWeight: number;
};

export type AmbientDecisionInput = AmbientEvidenceInput & {
  readonly state: AmbientState | null;
  readonly eventId: string;
  readonly appraisal: AmbientAppraisalParseResult;
};

export type AmbientDecisionResult = {
  readonly audit: AmbientDecisionAudit;
  readonly driveUpdate: AmbientState | null;
  readonly evidenceWeight: number;
  readonly probability: number;
  readonly draw: number | null;
  readonly shouldSpeak: boolean;
};

export function classifyAmbientAppraisal(result: AmbientAppraisalParseResult): "valid" | "invalid" {
  return result.kind;
}

export function isExplicitAmbientAddress(
  message: Pick<DiscordInboundMessage, "mentions" | "replyTo">,
  botUserId: string,
): boolean {
  return message.mentions.includes(botUserId) || message.replyTo?.authorId === botUserId;
}

export function calculateAmbientEvidenceWeight(input: AmbientEvidenceInput): number {
  if (isExplicitAmbientAddress(input.message, input.botUserId)) return 1;
  if (!isFreshCompleteRoster(input.roster, input.nowMs)) return 0;

  const activeHumanCount = new Set(input.activeHumanIds).size;
  if (activeHumanCount >= 2) return 0.5;
  return activeHumanCount === 1 ? 0.25 : 0;
}

export function calculateNextAmbientDrive(previousState: AmbientState | null, desiredDrive: number): number | null {
  if (!isUnitInterval(desiredDrive)) return null;

  const previousDrive = previousState === null ? DEFAULT_DRIVE : previousState.drive;
  if (!isUnitInterval(previousDrive)) return null;
  return clampUnitInterval(previousDrive * 0.75 + desiredDrive * 0.25);
}

export function calculateAmbientProbability(input: AmbientProbabilityInput): number {
  if (input.decision !== "speak" || !input.validChunks) return 0;
  if (!isUnitInterval(input.nextDrive) || !isUnitInterval(input.confidence) || !isUnitInterval(input.evidenceWeight)) return 0;
  return clampUnitInterval(input.nextDrive * input.confidence * input.evidenceWeight) ?? 0;
}

export function stableAmbientDraw(scopeId: string, eventId: string): number {
  const digest = createHash("sha256").update(`ambient-v1:${scopeId}:${eventId}`).digest();
  let first53Bits = 0n;
  for (let index = 0; index < 6; index += 1) {
    first53Bits = (first53Bits << 8n) | BigInt(digest[index] ?? 0);
  }
  first53Bits = (first53Bits << 5n) | BigInt((digest[6] ?? 0) >> 3);
  return Number(first53Bits) / DRAW_DENOMINATOR;
}

export function evaluateAmbientDecision(input: AmbientDecisionInput): AmbientDecisionResult {
  const evidenceWeight = calculateAmbientEvidenceWeight(input);
  switch (input.appraisal.kind) {
    case "invalid":
      return invalidDecision(input, evidenceWeight, input.appraisal.diagnostic);
    case "valid":
      return validDecision(input, evidenceWeight, input.appraisal.proposal);
  }
}

function validDecision(
  input: AmbientDecisionInput,
  evidenceWeight: number,
  proposal: AmbientAppraisalProposal,
): AmbientDecisionResult {
  const nextDrive = calculateNextAmbientDrive(input.state, proposal.desiredDrive);
  if (nextDrive === null || !hasExpectedStateScope(input.state, input.roster)) {
    return invalidDecision(input, evidenceWeight, "ambient state was invalid for this scope");
  }

  const driveUpdate: AmbientState = {
    scope: input.roster.scope,
    drive: nextDrive,
    version: input.state === null ? 1 : input.state.version + 1,
    updatedAtMs: input.nowMs,
  };
  const probability = calculateAmbientProbability({
    decision: proposal.decision,
    validChunks: hasValidAmbientChunks(proposal),
    nextDrive,
    confidence: proposal.confidence,
    evidenceWeight,
  });
  const draw = stableAmbientDraw(scopeId(input.roster), input.eventId);
  const shouldSpeak = probability > 0 && draw < probability;

  return {
    audit: {
      eventId: input.eventId,
      scope: input.roster.scope,
      proposal,
      outcome: shouldSpeak ? "planned" : "observe",
      diagnostic: null,
      recordedAtMs: input.nowMs,
    },
    driveUpdate,
    evidenceWeight,
    probability,
    draw,
    shouldSpeak,
  };
}

function invalidDecision(input: AmbientDecisionInput, evidenceWeight: number, diagnostic: string): AmbientDecisionResult {
  return {
    audit: {
      eventId: input.eventId,
      scope: input.roster.scope,
      proposal: null,
      outcome: "invalid",
      diagnostic,
      recordedAtMs: input.nowMs,
    },
    driveUpdate: null,
    evidenceWeight,
    probability: 0,
    draw: null,
    shouldSpeak: false,
  };
}

function hasValidAmbientChunks(proposal: AmbientAppraisalProposal): boolean {
  return proposal.decision === "observe" ? proposal.chunks.length === 0 : proposal.chunks.length >= 1 && proposal.chunks.length <= 5;
}

function isFreshCompleteRoster(roster: DiscordMembershipSnapshot, nowMs: number): boolean {
  return Number.isFinite(nowMs) && roster.complete && Number.isFinite(roster.observedAtMs)
    && nowMs >= roster.observedAtMs && nowMs - roster.observedAtMs <= ROSTER_FRESHNESS_MS;
}

function hasExpectedStateScope(state: AmbientState | null, roster: DiscordMembershipSnapshot): boolean {
  if (state === null) return true;
  return state.scope.guildId === roster.scope.guildId && state.scope.channelId === roster.scope.channelId
    && Number.isSafeInteger(state.version) && state.version >= 0 && Number.isFinite(state.updatedAtMs);
}

function clampUnitInterval(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function scopeId(scope: DiscordMembershipSnapshot): string {
  return `${scope.scope.guildId}:${scope.scope.channelId}`;
}
