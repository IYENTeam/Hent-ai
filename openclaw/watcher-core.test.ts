import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  approxGte,
  bigrams,
  check,
  compact,
  createNeutralConversationContext,
  detectCorrectionDrivenFixation,
  detectStaleRepetition,
  evaluateFixation,
  evaluateFixtureResult,
  evaluateHostPolicyGate,
  hasAny,
  inferTopic,
  jaccard,
  latestInstruction,
  maxPairwiseSimilarity,
  planExternalNudge,
  similarity,
  tokenize,
  trailingTopicRun,
  DEFAULT_NOW,
  type GoldenReplayFixture,
  type InternalAntiFixationSignal,
  type RawConversationMessage,
} from "./watcher-core.js";

const agent = (id: string, text: string): RawConversationMessage => ({
  id,
  senderRole: "agent",
  ts: DEFAULT_NOW,
  text,
});
const user = (id: string, text: string): RawConversationMessage => ({
  id,
  senderRole: "user",
  ts: DEFAULT_NOW,
  text,
});

const sampleSignal = (): InternalAntiFixationSignal => ({
  schema: "conversation_watcher.internal_anti_fixation_signal.v1",
  signalId: "sig-1",
  scopeId: "channel:1",
  reason: "r",
  staleFrame: "frame",
  newContextEvidence: "ev",
  suggestedPivot: "pivot",
  sourceMessageIds: ["a", "b"],
  confidence: 0.6,
  severity: "high",
  fixationPattern: "stale_expression_repeated",
  createdAt: DEFAULT_NOW,
});

describe("string helpers", () => {
  it("compact returns short text unchanged and truncates long text", () => {
    expect(compact("  hello   world ")).toBe("hello world");
    expect(compact("abcdef", 4)).toBe("abc…");
  });

  it("hasAny is case-insensitive and reports misses", () => {
    expect(hasAny("Hello World", ["world"])).toBe(true);
    expect(hasAny("hello", ["nope"])).toBe(false);
  });

  it("tokenize lowercases, keeps letter/number runs, drops stop words and empty matches", () => {
    expect(tokenize("The Quick brown 42 the")).toEqual(["quick", "brown", "42"]);
    expect(tokenize("!!! ??? ...")).toEqual([]);
  });

  it("inferTopic returns conversation for empty tokens and first content tokens otherwise", () => {
    expect(inferTopic("!!!")).toBe("conversation");
    expect(inferTopic("deploy the staging server immediately because reasons")).toBe(
      "deploy staging server immediately",
    );
  });

  it("latestInstruction detects directives and returns null otherwise", () => {
    expect(latestInstruction("please stop and do this instead")).toBe(
      "please stop and do this instead",
    );
    expect(latestInstruction("sounds good to me")).toBeNull();
  });

  it("check wraps a verdict", () => {
    expect(check("passed", "ok")).toEqual({ verdict: "passed", reason: "ok" });
  });
});

describe("similarity math", () => {
  it("approxGte honors default and custom epsilon", () => {
    expect(approxGte(0.6, 0.6)).toBe(true);
    expect(approxGte(0.59, 0.6)).toBe(false);
    expect(approxGte(0.59, 0.6, 0.02)).toBe(true);
  });

  it("jaccard handles empty union, hits and misses", () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  it("bigrams needs at least two tokens", () => {
    expect(bigrams(["a"])).toEqual([]);
    expect(bigrams(["a", "b", "c"])).toEqual(["a b", "b c"]);
  });

  it("similarity returns the max of token and bigram jaccard", () => {
    expect(similarity("alpha beta gamma", "alpha beta gamma delta epsilon")).toBeCloseTo(0.6, 10);
    expect(similarity("xyz", "totally different words here")).toBe(0);
  });

  it("maxPairwiseSimilarity is 0 for a single text and finds the strongest pair", () => {
    expect(maxPairwiseSimilarity(["only one"])).toBe(0);
    expect(maxPairwiseSimilarity(["a b c", "a b c", "z y x"])).toBe(1);
  });

  it("trailingTopicRun counts the trailing run and stops at a change", () => {
    expect(trailingTopicRun([])).toBe(0);
    expect(trailingTopicRun(["x", "y", "y", "y"])).toBe(3);
  });
});

describe("detectStaleRepetition", () => {
  it("returns nothing with fewer than two agent turns", () => {
    expect(detectStaleRepetition([agent("a1", "hi")], "channel:1")).toEqual([]);
  });

  it("fires a high-severity repetition signal on near-duplicate turns", () => {
    const msgs = [agent("a1", "ship it now"), agent("a2", "ship it now")];
    const [signal] = detectStaleRepetition(msgs, "channel:1");
    expect(signal?.fixationPattern).toBe("stale_expression_repeated");
    expect(signal?.severity).toBe("high");
    expect(signal?.reason).toMatch(/near-duplicate/);
  });

  it("fires a medium-severity persistence signal when stuck on a frame", () => {
    const msgs = [
      agent("a1", "deploy staging server immediately because alpha delta echo"),
      agent("a2", "deploy staging server immediately because beta hotel india"),
      agent("a3", "deploy staging server immediately because gamma juliet kilo"),
    ];
    const [signal] = detectStaleRepetition(msgs, "channel:1", { now: "2026-01-01T00:00:00.000Z" });
    expect(signal?.severity).toBe("medium");
    expect(signal?.reason).toMatch(/same frame/);
    expect(signal?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("stays silent on persistent frames whose similarity is below the floor", () => {
    const msgs = [
      agent("a1", "deploy staging server immediately because alpha delta echo foxtrot golf"),
      agent("a2", "deploy staging server immediately because beta hotel india juliet kilo"),
      agent("a3", "deploy staging server immediately because gamma lima mike november oscar"),
    ];
    expect(detectStaleRepetition(msgs, "channel:1")).toEqual([]);
  });

  it("stays silent on varied turns and honors custom options", () => {
    const msgs = [
      agent("a1", "the weather is sunny today"),
      agent("a2", "lunch plans involve sushi downtown"),
    ];
    expect(
      detectStaleRepetition(msgs, "channel:1", {
        windowN: 8,
        persistenceK: 3,
        simThreshold: 0.6,
        persistenceSimFloor: 0.4,
      }),
    ).toEqual([]);
  });
});

describe("detectCorrectionDrivenFixation", () => {
  it("fires when the agent repeats the frame after an explicit correction", () => {
    const msgs = [
      agent("a1", "should deploy staging server right away before lunch"),
      user("u1", "stop, focus on the billing bug instead"),
      agent("a2", "should deploy staging server because priority today honestly"),
    ];
    const [signal] = detectCorrectionDrivenFixation(msgs, "channel:1");
    expect(signal?.fixationPattern).toBe("new_context_ignored_previous_frame_repeated");
    expect(signal?.confidence).toBe(0.9);
  });

  it("skips non agent/user/agent triples", () => {
    const msgs = [user("u1", "stop instead"), user("u2", "stop instead"), user("u3", "stop instead")];
    expect(detectCorrectionDrivenFixation(msgs, "channel:1")).toEqual([]);
  });

  it("requires an actual correction instruction", () => {
    const msgs = [
      agent("a1", "alpha bravo charlie delta one"),
      user("u1", "alpha bravo charlie delta okay"),
      agent("a2", "alpha bravo charlie delta two"),
    ];
    expect(detectCorrectionDrivenFixation(msgs, "channel:1")).toEqual([]);
  });

  it("requires the repeated frame to differ from the new topic", () => {
    const msgs = [
      agent("a1", "alpha bravo charlie delta one"),
      user("u1", "alpha bravo charlie delta stop"),
      agent("a2", "alpha bravo charlie delta two"),
    ];
    expect(detectCorrectionDrivenFixation(msgs, "channel:1", { now: DEFAULT_NOW })).toEqual([]);
  });

  it("requires a repeated frame", () => {
    const msgs = [
      agent("a1", "talk about migration plans"),
      user("u1", "stop, do the rollback instead"),
      agent("a2", "completely different subject entirely now"),
    ];
    expect(detectCorrectionDrivenFixation(msgs, "channel:1")).toEqual([]);
  });
});

describe("evaluateFixation", () => {
  it("combines stale and correction signals", () => {
    const msgs = [
      agent("a1", "deploy now deploy now"),
      agent("a2", "deploy now deploy now"),
    ];
    expect(evaluateFixation(msgs, "channel:1").length).toBeGreaterThan(0);
  });
});

describe("createNeutralConversationContext", () => {
  it("handles an empty transcript with low confidence", () => {
    const ctx = createNeutralConversationContext("channel:1", []);
    expect(ctx.confidence).toBe(0.1);
    expect(ctx.currentTopic).toBe("conversation");
    expect(ctx.recentUserIntent).toBeNull();
    expect(ctx.latestExplicitInstruction).toBeNull();
    expect(ctx.openQuestions).toEqual([]);
  });

  it("captures instruction, discontinuities (intent + topic), and open questions", () => {
    const msgs = [
      user("u1", "tell me about cats?"),
      agent("a1", "cats are great"),
      user("u2", "no, stop, talk about dogs instead"),
      user("u3", "what about fish"),
    ];
    const ctx = createNeutralConversationContext("channel:1", msgs, "2026-02-02T00:00:00.000Z");
    expect(ctx.latestExplicitInstruction).not.toBeNull();
    expect(ctx.openQuestions).toContain("tell me about cats?");
    const kinds = ctx.contextDiscontinuities.map((d) => d.kind);
    expect(kinds).toContain("intent");
    expect(kinds).toContain("topic");
    expect(ctx.createdAt).toBe("2026-02-02T00:00:00.000Z");
    expect(ctx.confidence).toBe(0.82);
  });
});

describe("planExternalNudge", () => {
  it("builds a nudge with default and explicit targets", () => {
    const a = planExternalNudge("openclaw", sampleSignal(), "pivot please");
    expect(a.target).toEqual({ runtime: "openclaw" });
    expect(a.identityDisclosure).toBe("agent_explicit");
    const b = planExternalNudge(
      "hermes",
      sampleSignal(),
      "pivot",
      { channel: "c", threadId: "t" },
      "2026-03-03T00:00:00.000Z",
    );
    expect(b.target).toEqual({ runtime: "hermes", channel: "c", threadId: "t" });
    expect(b.createdAt).toBe("2026-03-03T00:00:00.000Z");
  });
});

describe("evaluateHostPolicyGate", () => {
  it("allows delivery and passes the delivery id through", () => {
    const audit = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: sampleSignal(),
      criticConfidence: 0.8,
      deliveryMessageId: "d1",
    });
    expect(audit.allowed).toBe(true);
    expect(audit.deliveryMessageId).toBe("d1");
    expect(audit.suppressedReason).toBeUndefined();
    expect(audit.cooldownKey).toBe("channel:1:stale_expression_repeated");
  });

  it("suppresses for shadow_mode (highest precedence) and drops delivery id", () => {
    const audit = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: sampleSignal(),
      criticConfidence: 0.8,
      shadowMode: true,
      cooldownHit: true,
      deliveryMessageId: "d1",
    });
    expect(audit.allowed).toBe(false);
    expect(audit.suppressedReason).toBe("shadow_mode");
    expect(audit.deliveryMessageId).toBeUndefined();
  });

  it("suppresses for cooldown, duplicate and privacy in order", () => {
    expect(
      evaluateHostPolicyGate({ runtime: "openclaw", signal: sampleSignal(), criticConfidence: 1, cooldownHit: true })
        .suppressedReason,
    ).toBe("cooldown");
    expect(
      evaluateHostPolicyGate({ runtime: "openclaw", signal: sampleSignal(), criticConfidence: 1, duplicateHit: true })
        .suppressedReason,
    ).toBe("duplicate");
    expect(
      evaluateHostPolicyGate({ runtime: "openclaw", signal: sampleSignal(), criticConfidence: 1, privacyRisk: true })
        .suppressedReason,
    ).toBe("privacy");
  });

  it("suppresses on thread mismatch and on cross-thread risk", () => {
    const mismatch = evaluateHostPolicyGate({
      runtime: "hermes",
      signal: sampleSignal(),
      criticConfidence: 1,
      sourceThreadId: "t1",
      targetThreadId: "t2",
      now: "2026-04-04T00:00:00.000Z",
    });
    expect(mismatch.suppressedReason).toBe("thread_mismatch");
    expect(mismatch.threadCheck.reason).toMatch(/mismatch/);
    expect(mismatch.createdAt).toBe("2026-04-04T00:00:00.000Z");

    const cross = evaluateHostPolicyGate({
      runtime: "hermes",
      signal: sampleSignal(),
      criticConfidence: 1,
      sourceThreadId: "t1",
      targetThreadId: "t1",
      crossThreadRisk: true,
    });
    expect(cross.suppressedReason).toBe("thread_mismatch");
    expect(cross.threadCheck.reason).toMatch(/span multiple threads/);
  });
});

describe("golden fixtures (TS side of parity)", () => {
  const golden = JSON.parse(
    readFileSync(new URL("../tests/fixtures/watcher-golden.json", import.meta.url), "utf-8"),
  ) as { fixtures: GoldenReplayFixture[] };

  it("loads the shared fixtures", () => {
    expect(golden.fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const fixture of golden.fixtures) {
    it(`matches expected result for ${fixture.name}`, () => {
      const result = evaluateFixtureResult(fixture);
      expect(result.fixated).toBe(fixture.expectedFixated);
      expect(result.patterns.sort()).toEqual([...fixture.expectedPatterns].sort());
    });
  }

  it("pins the boundary fixture similarity at exactly 0.6", () => {
    const boundary = golden.fixtures.find((f) => f.name === "similarity_boundary_positive");
    expect(boundary).toBeDefined();
    const texts = boundary!.rawMessages.filter((m) => m.senderRole === "agent").map((m) => m.text);
    expect(maxPairwiseSimilarity(texts)).toBeCloseTo(0.6, 10);
  });
});
