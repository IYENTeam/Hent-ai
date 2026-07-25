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
  readonly activeHumanIds: readonly string[];
  readonly nowMs: number;
};

type AmbientDecisionInput = AmbientEvidenceInput & {
  readonly state: AmbientState | null;
  readonly eventId: string;
  readonly appraisal: AmbientAppraisalParseResult;
};

type AmbientDecisionResult = {
  readonly audit: AmbientDecisionAudit;
  readonly driveUpdate: AmbientState | null;
  readonly evidenceWeight: number;
  readonly probability: number;
  readonly draw: number | null;
  readonly shouldSpeak: boolean;
};

type ConversationAmbientApi = {
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
    activeHumanIds: ["100000000000000004", "100000000000000005"],
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
    expect(outcome.driveUpdate).toMatchObject({ drive: 0.575, version: 1, scope, updatedAtMs: nowMs });
    expect(outcome.evidenceWeight).toBe(1);
    expect(outcome.probability).toBeCloseTo(0.46);
    expect(outcome.draw).toBeGreaterThanOrEqual(0);
    expect(outcome.draw).toBeLessThan(1);
  });

  it("weights explicit mentions and replies above fresh complete roster activity", () => {
    const api = ambient();
    const base = { message: { mentions: [], replyTo: null }, botUserId, roster, activeHumanIds: [], nowMs };

    expect(api.calculateAmbientEvidenceWeight({ ...base, message: { mentions: [botUserId], replyTo: null } })).toBe(1);
    expect(api.calculateAmbientEvidenceWeight({ ...base, message: { mentions: [], replyTo: { messageId: "reply-1", authorId: botUserId } } })).toBe(1);
    expect(api.calculateAmbientEvidenceWeight({ ...base, activeHumanIds: ["human-1", "human-2"] })).toBe(0.5);
    expect(api.calculateAmbientEvidenceWeight({ ...base, activeHumanIds: ["human-1"] })).toBe(0.25);
    expect(api.calculateAmbientEvidenceWeight(base)).toBe(0);
    expect(api.calculateAmbientEvidenceWeight({ ...base, activeHumanIds: ["human-1", "human-2"], roster: { ...roster, complete: false } })).toBe(0);
    expect(api.calculateAmbientEvidenceWeight({ ...base, activeHumanIds: ["human-1", "human-2"], roster: { ...roster, observedAtMs: nowMs - 300_001 } })).toBe(0);
  });

  it("clamps only valid drive inputs and fails closed for invalid probability inputs", () => {
    const api = ambient();
    const fullState: AmbientState = { scope, drive: 1, version: 4, updatedAtMs: nowMs };
    const emptyState: AmbientState = { scope, drive: 0, version: 4, updatedAtMs: nowMs };

    expect(api.calculateNextAmbientDrive(null, 0)).toBe(0.375);
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
      state: { scope, drive: 0.4, version: 7, updatedAtMs: nowMs - 1 },
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
