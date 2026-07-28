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
const INITIAL_DRIVE = 0.7;
export const IDLE_DECAY_TAU_MS = 2 * 3_600_000;
export const PRESSURE_TAU_MS = 30 * 60_000;
const ROSTER_FRESHNESS_MS = 5 * 60 * 1000;
const DRAW_DENOMINATOR = 2 ** 53;

export type AmbientEvidenceInput = {
  readonly message: Pick<DiscordInboundMessage, "mentions" | "replyTo">;
  readonly botUserId: string;
  readonly roster: DiscordMembershipSnapshot;
  readonly nowMs: number;
};

export type AmbientProbabilityInput = {
  readonly decision: AmbientAppraisalProposal["decision"];
  readonly validChunks: boolean;
  readonly nextDrive: number;
  readonly confidence: number;
  readonly evidenceWeight: number;
};

type AmbientStateWithStreaks = AmbientState & { readonly speakStreak?: number; readonly skipStreak?: number };

export type AmbientDecisionInput = AmbientEvidenceInput & {
  readonly state: AmbientStateWithStreaks | null;
  readonly eventId: string;
  readonly appraisal: AmbientAppraisalParseResult;
  readonly observeOnly?: boolean;
  readonly ambientPityEnabled?: boolean;
  readonly confidenceFloor?: number;
  readonly idleDecayTauMs?: number;
  readonly pressureTauMs?: number;
};

export type AmbientDecisionResult = {
  readonly audit: AmbientDecisionAudit;
  readonly driveUpdate: AmbientStateWithStreaks | null;
  readonly evidenceWeight: number;
  readonly probability: number;
  readonly draw: number | null;
  readonly shouldSpeak: boolean;
};

export function classifyAmbientAppraisal(result: AmbientAppraisalParseResult): "valid" | "invalid" | "unavailable" {
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

  return 0.8;
}

export function applyAmbientIdleDecay(drive: number, updatedAtMs: number, nowMs: number, tauMs: number): number {
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(tauMs) || tauMs <= 0) return drive;
  const dtMs = nowMs - updatedAtMs;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return drive;
  return Math.min(1, Math.max(0, DEFAULT_DRIVE + (drive - DEFAULT_DRIVE) * Math.exp(-dtMs / tauMs)));
}

export function applyAmbientPressure(
  state: Pick<AmbientState, "pressure" | "pressureUpdatedAtMs"> | null,
  appraisal: AmbientAppraisalParseResult,
  nowMs: number,
  tauMs = PRESSURE_TAU_MS,
): number {
  const pressure = applyAmbientPressureDecay(state?.pressure ?? 0, state?.pressureUpdatedAtMs ?? null, nowMs, tauMs);
  if (appraisal.kind !== "valid") return pressure;
  const silenceRequest = appraisal.proposal.silenceRequest;
  if (silenceRequest?.present !== true) return pressure;
  return clampUnitInterval(pressure + silenceRequestIntensity(silenceRequest.intensity) * appraisal.proposal.confidence) ?? pressure;
}

export function calculateNextAmbientDrive(previousState: AmbientState | null, desiredDrive: number): number | null {
  if (!isUnitInterval(desiredDrive)) return null;

  const previousDrive = previousState === null ? INITIAL_DRIVE : previousState.drive;
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
    case "unavailable":
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
  const pressure = applyAmbientPressure(input.state, input.appraisal, input.nowMs, input.pressureTauMs ?? PRESSURE_TAU_MS);
  const previousState = input.state === null ? null : {
    ...input.state,
    drive: applyAmbientIdleDecay(input.state.drive, input.state.updatedAtMs, input.nowMs, input.idleDecayTauMs ?? IDLE_DECAY_TAU_MS),
  };
  const nextDrive = calculateNextAmbientDrive(previousState, proposal.desiredDrive * (1 - pressure));
  if (nextDrive === null || !hasExpectedStateScope(input.state, input.roster)) {
    return invalidDecision(input, evidenceWeight, "ambient state was invalid for this scope");
  }

  const validChunks = hasValidAmbientChunks(proposal);
  const baseProbability = calculateAmbientProbability({
    decision: proposal.decision,
    validChunks,
    nextDrive,
    confidence: proposal.confidence,
    evidenceWeight,
  });
  const opportunity = proposal.decision === "speak" && validChunks && proposal.confidence >= (input.confidenceFloor ?? 0.6) && !input.observeOnly;
  const probability = opportunity ? applyAmbientPityBoost(baseProbability, input.state, input.ambientPityEnabled ?? true) : baseProbability;
  const draw = stableAmbientDraw(scopeId(input.roster), input.eventId);
  const shouldSpeak = probability > 0 && draw < probability;
  const streaks = nextAmbientStreaks(input.state, opportunity, shouldSpeak);
  const driveUpdate: AmbientStateWithStreaks = {
    scope: input.roster.scope,
    drive: nextDrive,
    version: input.state === null ? 1 : input.state.version + 1,
    updatedAtMs: input.nowMs,
    pressure,
    pressureUpdatedAtMs: input.nowMs,
    ...streaks,
  };

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

function applyAmbientPityBoost(baseProbability: number, state: AmbientStateWithStreaks | null, enabled: boolean): number {
  if (!enabled || baseProbability <= 0) return baseProbability;
  const skipStreak = ambientStreak(state?.skipStreak);
  const speakStreak = ambientStreak(state?.speakStreak);
  let probability = 1 - (1 - baseProbability) ** (1 + skipStreak);
  if (speakStreak >= Math.floor(1 / baseProbability)) probability *= 0.5;
  return clampUnitInterval(probability) ?? 0;
}

function nextAmbientStreaks(state: AmbientStateWithStreaks | null, opportunity: boolean, shouldSpeak: boolean): Pick<AmbientStateWithStreaks, "speakStreak" | "skipStreak"> {
  const speakStreak = ambientStreak(state?.speakStreak);
  const skipStreak = ambientStreak(state?.skipStreak);
  if (!opportunity) return { speakStreak, skipStreak };
  return shouldSpeak ? { speakStreak: speakStreak + 1, skipStreak: 0 } : { speakStreak, skipStreak: skipStreak + 1 };
}

function ambientStreak(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
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

function applyAmbientPressureDecay(pressure: number, pressureUpdatedAtMs: number | null, nowMs: number, tauMs: number): number {
  const currentPressure = clampUnitInterval(pressure) ?? 0;
  if (typeof pressureUpdatedAtMs !== "number" || !Number.isFinite(pressureUpdatedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(tauMs) || tauMs <= 0) return currentPressure;
  const dtMs = Math.max(0, nowMs - pressureUpdatedAtMs);
  if (!Number.isFinite(dtMs)) return currentPressure;
  return clampUnitInterval(currentPressure * Math.exp(-dtMs / tauMs)) ?? currentPressure;
}

function silenceRequestIntensity(intensity: "mild" | "strong" | "moderator"): number {
  switch (intensity) {
    case "mild": return 0.5;
    case "strong": return 0.8;
    case "moderator": return 1;
  }
}

function isFreshCompleteRoster(roster: DiscordMembershipSnapshot, nowMs: number): boolean {
  return Number.isFinite(nowMs) && roster.complete && Number.isFinite(roster.observedAtMs)
    && nowMs >= roster.observedAtMs && nowMs - roster.observedAtMs <= ROSTER_FRESHNESS_MS;
}

function hasExpectedStateScope(state: AmbientState | null, roster: DiscordMembershipSnapshot): boolean {
  if (state === null) return true;
  return state.scope.guildId === roster.scope.guildId && state.scope.channelId === roster.scope.channelId
    && Number.isSafeInteger(state.version) && state.version >= 0;
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
