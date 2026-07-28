import { describe, expect, it } from "vitest";
import * as service from "./index.js";
import {
  ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS,
  parseAmbientAppraisalProposal,
  type AmbientAppraisalParseResult,
  type AmbientDecisionAudit,
  type AmbientState,
  type DiscordInboundMessage,
  type DiscordMembershipSnapshot,
} from "./adaptive-ambient-contracts.js";

type AmbientEvidenceInput = {
  readonly message: Pick<DiscordInboundMessage, "mentions" | "replyTo">;
  readonly botUserId: string;
  readonly roster: DiscordMembershipSnapshot;
  readonly nowMs: number;
};

type AmbientStateWithStreaks = AmbientState & { readonly speakStreak?: number; readonly skipStreak?: number };

type AmbientDecisionInput = AmbientEvidenceInput & {
  readonly state: AmbientStateWithStreaks | null;
  readonly eventId: string;
  readonly appraisal: AmbientAppraisalParseResult;
  readonly observeOnly?: boolean;
  readonly ambientPityEnabled?: boolean;
  readonly confidenceFloor?: number;
};

type AmbientDecisionResult = {
  readonly audit: AmbientDecisionAudit;
  readonly driveUpdate: AmbientState | null;
  readonly evidenceWeight: number;
  readonly probability: number;
  readonly draw: number | null;
  readonly shouldSpeak: boolean;
};

type PressureState = AmbientState & { readonly pressure?: number; readonly pressureUpdatedAtMs?: number | null };

type ConversationAmbientApi = {
  readonly applyAmbientIdleDecay: (drive: number, updatedAtMs: number, nowMs: number, tauMs: number) => number;
  readonly applyAmbientPressure: (state: PressureState | null, appraisal: AmbientAppraisalParseResult, nowMs: number, tauMs?: number) => number;
  readonly calculateAmbientEvidenceWeight: (input: AmbientEvidenceInput) => number;
  readonly calculateAmbientProbability: (input: {
    readonly decision: "observe" | "speak";
    readonly validChunks: boolean;
    readonly nextDrive: number;
    readonly confidence: number;
    readonly evidenceWeight: number;
  }) => number;
  readonly calculateNextAmbientDrive: (state: AmbientState | null, desiredDrive: number) => number | null;
  readonly evaluateAmbientDecision: (input: AmbientDecisionInput) => AmbientDecisionResult;
  readonly stableAmbientDraw: (scopeId: string, eventId: string) => number;
};

const scope = { guildId: "100000000000000001", channelId: "100000000000000002" };
const botUserId = "100000000000000003";
const nowMs = 1_000_000;
const roster: DiscordMembershipSnapshot = {
  scope,
  memberIds: ["100000000000000004", "100000000000000005"],
  complete: true,
  observedAtMs: nowMs - 1,
};

function conversationAmbientApi(): ConversationAmbientApi | null {
  const candidate = service as object;
  const keys: readonly (keyof ConversationAmbientApi)[] = [
    "applyAmbientIdleDecay",
    "applyAmbientPressure",
    "calculateAmbientEvidenceWeight",
    "calculateAmbientProbability",
    "calculateNextAmbientDrive",
    "evaluateAmbientDecision",
    "stableAmbientDraw",
  ];
  if (!keys.every((key) => key in candidate && typeof Reflect.get(candidate, key) === "function")) return null;
  return candidate as ConversationAmbientApi;
}

function ambient(): ConversationAmbientApi {
  const api = conversationAmbientApi();
  if (api === null) throw new Error("ambient public API was unavailable");
  return api;
}

function appraisal(overrides: Record<string, unknown> = {}): AmbientAppraisalParseResult {
  return parseAmbientAppraisalProposal(JSON.stringify({
    schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal,
    decision: "speak",
    desiredDrive: 0.8,
    confidence: 0.8,
    chunks: ["A useful bubble."],
    relationshipProposals: [],
    ...overrides,
  }));
}

function decisionInput(overrides: Partial<AmbientDecisionInput> = {}): AmbientDecisionInput {
  return {
    state: null,
    eventId: "event-1",
    appraisal: appraisal(),
    message: { mentions: [botUserId], replyTo: null },
    botUserId,
    roster,
    nowMs,
    ...overrides,
  };
}

describe("adaptive ambient drive and evidence", () => {
  it("calculates exact drive and evidence probability", () => {
    // Given: the public service boundary for the pure ambient decision algorithm.
    const api = conversationAmbientApi();

    // When: an addressed, valid speak proposal is evaluated.
    // Then: the algorithm is available through the service namespace.
    expect(api).not.toBeNull();
    expect(typeof api?.evaluateAmbientDecision).toBe("function");

    const outcome = ambient().evaluateAmbientDecision(decisionInput());
    expect(outcome.driveUpdate).toMatchObject({ drive: 0.7 * 0.75 + 0.8 * 0.25, version: 1, scope, updatedAtMs: nowMs });
    expect(outcome.evidenceWeight).toBe(1);
    expect(outcome.probability).toBeCloseTo(0.58);
    expect(outcome.draw).toBeGreaterThanOrEqual(0);
    expect(outcome.draw).toBeLessThan(1);
  });

  it("weights explicit mentions and replies above any fresh complete roster", () => {
    const api = ambient();
    const base = { message: { mentions: [], replyTo: null }, botUserId, roster, nowMs };

    expect(api.calculateAmbientEvidenceWeight({ ...base, message: { mentions: [botUserId], replyTo: null } })).toBe(1);
    expect(api.calculateAmbientEvidenceWeight({ ...base, message: { mentions: [], replyTo: { messageId: "reply-1", authorId: botUserId } } })).toBe(1);
    expect(api.calculateAmbientEvidenceWeight(base)).toBe(0.8);
    expect(api.calculateAmbientEvidenceWeight({ ...base, roster: { ...roster, complete: false } })).toBe(0);
    expect(api.calculateAmbientEvidenceWeight({ ...base, roster: { ...roster, observedAtMs: nowMs - 300_001 } })).toBe(0);
  });

  it("relaxes ambient drive toward baseline across idle time without changing the EMA", () => {
    const api = ambient();
    const tauMs = 2 * 3_600_000;

    expect(api.applyAmbientIdleDecay(0.9, nowMs - tauMs, nowMs, tauMs)).toBeCloseTo(0.5 + 0.4 * Math.exp(-1));
    expect(api.applyAmbientIdleDecay(0.9, nowMs, nowMs, tauMs)).toBe(0.9);
    expect(api.applyAmbientIdleDecay(0.9, nowMs + 1, nowMs, tauMs)).toBe(0.9);
    expect(api.applyAmbientIdleDecay(0.9, Number.NaN, nowMs, tauMs)).toBe(0.9);
    expect(api.applyAmbientIdleDecay(0.9, nowMs - 1, nowMs, 0)).toBe(0.9);
    expect(api.applyAmbientIdleDecay(10, nowMs - 1, nowMs, 1_000_000_000)).toBe(1);
    expect(api.applyAmbientIdleDecay(-10, nowMs - 1, nowMs, 1_000_000_000)).toBe(0);

    const first = api.evaluateAmbientDecision(decisionInput({ appraisal: appraisal({ desiredDrive: 0.8 }) }));
    expect(first.driveUpdate?.drive).toBe(0.7 * 0.75 + 0.8 * 0.25);

    const stale = api.evaluateAmbientDecision(decisionInput({
      state: { scope, drive: 0.8, version: 7, updatedAtMs: Number.NaN },
      appraisal: appraisal({ desiredDrive: 0.8 }),
    }));
    expect(stale.driveUpdate).toMatchObject({ drive: 0.8, version: 8, updatedAtMs: nowMs });
  });

  it("accumulates decaying silence pressure without making addressed speech impossible", () => {
    const api = ambient();
    const mild = appraisal({ confidence: 0.7, silenceRequest: { present: true, intensity: "mild" } });
    const singleMild = api.evaluateAmbientDecision(decisionInput({ appraisal: mild }));

    // A mild 0.7-confidence request produces pressure 0.5 * 0.7 = 0.35,
    // so the EMA receives desiredDrive 0.8 * (1 - 0.35) = 0.52.
    expect(singleMild.driveUpdate).toMatchObject({ drive: 0.7 * 0.75 + 0.52 * 0.25, pressure: 0.35, pressureUpdatedAtMs: nowMs });
    expect(singleMild.evidenceWeight).toBe(1);
    expect(singleMild.probability).toBeGreaterThan(0);
    expect(singleMild.shouldSpeak).toBe(true);
    expect("mute" in singleMild).toBe(false);
    expect("quietUntil" in singleMild).toBe(false);
    expect("forceSilent" in singleMild).toBe(false);

    const strong = appraisal({ desiredDrive: 1, confidence: 1, silenceRequest: { present: true, intensity: "strong" } });
    const firstStrong = api.evaluateAmbientDecision(decisionInput({ appraisal: strong }));
    const secondStrong = api.evaluateAmbientDecision(decisionInput({ state: firstStrong.driveUpdate as PressureState, appraisal: strong }));
    const thirdStrong = api.evaluateAmbientDecision(decisionInput({ state: secondStrong.driveUpdate as PressureState, appraisal: strong }));
    expect(thirdStrong.driveUpdate).toMatchObject({ pressure: 1 });
    expect(thirdStrong.driveUpdate?.drive).toBeCloseTo((secondStrong.driveUpdate?.drive ?? 0) * 0.75);

    const stalePressure: PressureState = { scope, drive: 0.5, version: 3, updatedAtMs: nowMs, pressure: 0.8, pressureUpdatedAtMs: nowMs - 30 * 60_000 };
    expect(api.applyAmbientPressure(stalePressure, appraisal(), nowMs, 30 * 60_000)).toBeCloseTo(0.8 * Math.exp(-1));
    expect(api.evaluateAmbientDecision(decisionInput({ state: stalePressure, appraisal: appraisal() })).driveUpdate).toMatchObject({ pressure: 0.8 * Math.exp(-1) });
    const legacyPressure: PressureState = { ...stalePressure, pressure: 0.4, pressureUpdatedAtMs: null };
    expect(api.applyAmbientPressure(legacyPressure, appraisal(), nowMs, 30 * 60_000)).toBe(0.4);
    expect(api.evaluateAmbientDecision(decisionInput({ state: legacyPressure, appraisal: appraisal() })).driveUpdate).toMatchObject({ pressure: 0.4 });

    const malformedSilence = appraisal({ silenceRequest: "garbage" });
    const malformedResult = api.evaluateAmbientDecision(decisionInput({ appraisal: malformedSilence }));
    expect(malformedResult.driveUpdate).toMatchObject({ pressure: 0 });
    const invalidResult: AmbientAppraisalParseResult = { kind: "invalid", diagnostic: "garbage silenceRequest" };
    expect(api.applyAmbientPressure(stalePressure, invalidResult, nowMs, 30 * 60_000)).toBeCloseTo(0.8 * Math.exp(-1));
    expect(api.evaluateAmbientDecision(decisionInput({ state: stalePressure, appraisal: invalidResult })).driveUpdate).toBeNull();
  });

  it("clamps only valid drive inputs and fails closed for invalid probability inputs", () => {
    const api = ambient();
    const fullState: AmbientState = { scope, drive: 1, version: 4, updatedAtMs: nowMs };
    const emptyState: AmbientState = { scope, drive: 0, version: 4, updatedAtMs: nowMs };

    expect(api.calculateNextAmbientDrive(null, 0)).toBe(0.7 * 0.75);
    expect(api.calculateNextAmbientDrive(fullState, 1)).toBe(1);
    expect(api.calculateNextAmbientDrive(emptyState, 0)).toBe(0);
    expect(api.calculateNextAmbientDrive(null, Number.NaN)).toBeNull();
    expect(api.calculateNextAmbientDrive(null, 1.01)).toBeNull();
    expect(api.calculateAmbientProbability({ decision: "speak", validChunks: true, nextDrive: 1, confidence: 1, evidenceWeight: 1 })).toBe(1);
    expect(api.calculateAmbientProbability({ decision: "speak", validChunks: false, nextDrive: 1, confidence: 1, evidenceWeight: 1 })).toBe(0);
    expect(api.calculateAmbientProbability({ decision: "observe", validChunks: true, nextDrive: 1, confidence: 1, evidenceWeight: 1 })).toBe(0);
    expect(api.calculateAmbientProbability({ decision: "speak", validChunks: true, nextDrive: Number.NaN, confidence: 1, evidenceWeight: 1 })).toBe(0);
    expect(api.calculateAmbientProbability({ decision: "speak", validChunks: true, nextDrive: 1, confidence: 1.01, evidenceWeight: 1 })).toBe(0);
  });

  it("uses a stable SHA-derived draw for the same scope and event", () => {
    const api = ambient();

    expect(api.stableAmbientDraw("guild:channel", "event-1")).toBe(api.stableAmbientDraw("guild:channel", "event-1"));
    expect(api.stableAmbientDraw("guild:channel", "event-1")).not.toBe(api.stableAmbientDraw("guild:channel", "event-2"));
  });

  it("advances drive for a valid observe proposal without planning speech", () => {
    const outcome = ambient().evaluateAmbientDecision(decisionInput({
      state: { scope, drive: 0.4, version: 7, updatedAtMs: nowMs },
      appraisal: appraisal({ decision: "observe", desiredDrive: 0.8, chunks: [] }),
    }));

    expect(outcome.driveUpdate).toMatchObject({ drive: 0.5, version: 8 });
    expect(outcome.audit.outcome).toBe("observe");
    expect(outcome.probability).toBe(0);
    expect(outcome.shouldSpeak).toBe(false);
  });

  it("keeps state version stable for invalid and low-confidence appraisals", () => {
    const existing: AmbientState = { scope, drive: 0.4, version: 7, updatedAtMs: nowMs - 1 };
    const malformed = appraisal({ chunks: [] });
    const lowConfidence = appraisal({ confidence: 0.69 });

    for (const invalidAppraisal of [malformed, lowConfidence]) {
      const outcome = ambient().evaluateAmbientDecision(decisionInput({ state: existing, appraisal: invalidAppraisal }));
      expect(outcome.driveUpdate).toBeNull();
      expect(outcome.audit).toMatchObject({ outcome: "invalid", proposal: null });
      expect(outcome.probability).toBe(0);
      expect(outcome.shouldSpeak).toBe(false);
    }
  });

  it("boosts probability after quiet streaks without forcing a decision", () => {
    const api = ambient();
    const baseState = { scope, drive: 0, version: 1, updatedAtMs: nowMs };
    const baseInput = {
      appraisal: appraisal({ desiredDrive: 0.5 }),
      state: baseState,
      eventId: "pity-high-draw",
    };

    const base = api.evaluateAmbientDecision(decisionInput({ ...baseInput, state: { ...baseState, skipStreak: 0, speakStreak: 0 } }));
    const boosted = api.evaluateAmbientDecision(decisionInput({ ...baseInput, state: { ...baseState, skipStreak: 4, speakStreak: 0 } }));
    const capped = api.evaluateAmbientDecision(decisionInput({ ...baseInput, state: { ...baseState, skipStreak: 0, speakStreak: 10 } }));
    const disabled = api.evaluateAmbientDecision(decisionInput({ ...baseInput, state: { ...baseState, skipStreak: 4, speakStreak: 0 }, ambientPityEnabled: false }));

    expect(base.probability).toBeCloseTo(0.1);
    expect(boosted.probability).toBeCloseTo(1 - 0.9 ** 5);
    expect(capped.probability).toBeCloseTo(0.05);
    expect(disabled.probability).toBeCloseTo(0.1);
    expect(boosted.shouldSpeak).toBe(false);
    expect(boosted.shouldSpeak).toBe(boosted.draw! < boosted.probability);
    expect(boosted.driveUpdate).toMatchObject({ speakStreak: 0, skipStreak: 5 });

    const speech = api.evaluateAmbientDecision(decisionInput({
      ...baseInput,
      eventId: "event-1",
      state: { ...baseState, skipStreak: 4, speakStreak: 2 },
    }));
    expect(speech.shouldSpeak).toBe(true);
    expect(speech.driveUpdate).toMatchObject({ speakStreak: 3, skipStreak: 0 });

    const providerObserve = api.evaluateAmbientDecision(decisionInput({
      ...baseInput,
      appraisal: appraisal({ decision: "observe", desiredDrive: 0.5, chunks: [] }),
      state: { ...baseState, skipStreak: 4, speakStreak: 2 },
    }));
    expect(providerObserve.driveUpdate).toMatchObject({ speakStreak: 2, skipStreak: 4 });

    const observeOnly = api.evaluateAmbientDecision(decisionInput({
      ...baseInput,
      eventId: "event-1",
      observeOnly: true,
      state: { ...baseState, skipStreak: 4, speakStreak: 2 },
    }));
    expect(observeOnly.driveUpdate).toMatchObject({ speakStreak: 2, skipStreak: 4 });
  });

  it("treats a be quiet request as social evidence while allowing resistant defiant output", () => {
    const api = ambient();
    const quietRequest = "be quiet";
    const baseline = api.evaluateAmbientDecision(decisionInput({
      message: { mentions: [botUserId], replyTo: null },
      appraisal: appraisal({ desiredDrive: 0.2, chunks: ["I can hold back when useful."] }),
    }));
    const resistant = api.evaluateAmbientDecision(decisionInput({
      eventId: "quiet-request-event",
      message: { mentions: [botUserId], replyTo: null },
      appraisal: appraisal({ desiredDrive: 0.95, chunks: ["I hear the request, but I have one defiant point to make."] }),
    }));

    expect(quietRequest).toBe("be quiet");
    expect(resistant.driveUpdate?.drive).toBeGreaterThan(baseline.driveUpdate?.drive ?? 0);
    expect(resistant.audit).toMatchObject({ outcome: resistant.shouldSpeak ? "planned" : "observe", proposal: { decision: "speak" } });
    expect("mute" in resistant).toBe(false);
    expect("quit" in resistant).toBe(false);
    expect("forceSilent" in resistant).toBe(false);
  });
});
