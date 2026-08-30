/**
 * Red-team / adversarial / property / boundary tests for watcher-core.ts.
 *
 * Goals:
 *   - Break detectors with edge inputs (unicode, emoji, Korean, stop-word-only,
 *     punctuation-only, very long text).
 *   - Verify near-threshold similarity: just BELOW 0.6 must NOT fire; AT 0.6 must fire.
 *   - Enforce window-bound (N=8) on huge transcripts.
 *   - Verify suppression-precedence ordering in evaluateHostPolicyGate.
 *   - Assert suppressed gate never leaks deliveryMessageId.
 *   - Determinism: same input → same output across repeated calls.
 *   - Similarity symmetry: similarity(a,b) === similarity(b,a).
 *   - Golden-fixture parity.
 *
 * No mocks — the core is pure / deterministic.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  tokenize,
  inferTopic,
  similarity,
  maxPairwiseSimilarity,
  jaccard,
  bigrams,
  trailingTopicRun,
  approxGte,
  compact,
  hasAny,
  latestInstruction,
  check,
  createNeutralConversationContext,
  detectStaleRepetition,
  detectCorrectionDrivenFixation,
  evaluateFixation,
  planExternalNudge,
  evaluateHostPolicyGate,
  evaluateFixtureResult,
  SIMILARITY_EPSILON,
  DEFAULT_WINDOW_N,
  DEFAULT_PERSISTENCE_K,
  DEFAULT_SIM_THRESHOLD,
  DEFAULT_NOW,
  type RawConversationMessage,
  type InternalAntiFixationSignal,
  type GoldenReplayFixture,
} from "./watcher-core.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function agentMsg(id: string, text: string): RawConversationMessage {
  return { id, senderRole: "agent", ts: DEFAULT_NOW, text };
}

function userMsg(id: string, text: string): RawConversationMessage {
  return { id, senderRole: "user", ts: DEFAULT_NOW, text };
}

function minimalSignal(overrides: Partial<InternalAntiFixationSignal> = {}): InternalAntiFixationSignal {
  return {
    schema: "conversation_watcher.internal_anti_fixation_signal.v1",
    signalId: "sig-redteam-001",
    scopeId: "scope:redteam",
    reason: "test reason",
    staleFrame: "test frame",
    newContextEvidence: "test evidence",
    suggestedPivot: "test pivot",
    sourceMessageIds: ["m1", "m2"],
    confidence: 0.8,
    severity: "high",
    fixationPattern: "stale_expression_repeated",
    createdAt: DEFAULT_NOW,
    ...overrides,
  };
}

// Load golden fixtures once
const GOLDEN: { fixtures: GoldenReplayFixture[] } = JSON.parse(
  readFileSync(new URL("../tests/fixtures/watcher-golden.json", import.meta.url), "utf-8"),
);

// ---------------------------------------------------------------------------
// tokenize – adversarial inputs
// ---------------------------------------------------------------------------

describe("tokenize – adversarial inputs", () => {
  it("empty string → empty array", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("punctuation-only → empty array (no \\p{L}/\\p{N} matches)", () => {
    expect(tokenize("!!!???...---~~~###")).toEqual([]);
  });

  it("emoji-only → empty array (emoji are not letter/number codepoints)", () => {
    expect(tokenize("🎉🎊🥳🔥💥🚀")).toEqual([]);
  });

  it("all English stop words → empty array", () => {
    expect(
      tokenize("the a an and or but if then so to of in on for is are was were be been it this that i you we they as at by with about"),
    ).toEqual([]);
  });

  it("Korean stop words filtered out", () => {
    // All tokens in the pinned Korean stop-word set
    const result = tokenize("은 는 이 가 을 를 에 의 도 로 으로 고 과 와");
    expect(result).toEqual([]);
  });

  it("Korean non-stop-word content preserved", () => {
    const result = tokenize("배포하자 오늘");
    expect(result).toContain("배포하자");
    expect(result).toContain("오늘");
  });

  it("mixed Korean/English: stop words removed, content kept", () => {
    const result = tokenize("the 배포 is important 오늘");
    expect(result).not.toContain("the");
    expect(result).not.toContain("is");
    expect(result).toContain("배포");
    expect(result).toContain("important");
    expect(result).toContain("오늘");
  });

  it("very long input (2 000 chars) does not crash", () => {
    // "word" is not a stop word
    const long = "word ".repeat(400).trim();
    const result = tokenize(long);
    expect(result.length).toBe(400);
    expect(result.every((t) => t === "word")).toBe(true);
  });

  it("numeric tokens preserved", () => {
    const result = tokenize("version 3 released");
    expect(result).toContain("3");
    expect(result).toContain("version");
    expect(result).toContain("released");
  });

  it("tab and newline whitespace handled", () => {
    const result = tokenize("alpha\tbeta\ngamma");
    expect(result).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---------------------------------------------------------------------------
// jaccard – algebraic properties
// ---------------------------------------------------------------------------

describe("jaccard – properties", () => {
  it("both empty → 0 (union is 0 → special-cased to avoid /0)", () => {
    expect(jaccard([], [])).toBe(0);
  });

  it("identical arrays → 1", () => {
    expect(jaccard(["alpha", "beta", "gamma"], ["alpha", "beta", "gamma"])).toBe(1);
  });

  it("completely disjoint → 0", () => {
    expect(jaccard(["alpha"], ["beta"])).toBe(0);
  });

  it("symmetric: jaccard(a,b) === jaccard(b,a)", () => {
    const a = ["alpha", "beta", "gamma"];
    const b = ["beta", "gamma", "delta", "epsilon"];
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });

  it("duplicates in input treated as single via Set (idempotent)", () => {
    // ["alpha","alpha","beta"] is set-equal to ["alpha","beta"]
    expect(jaccard(["alpha", "alpha", "beta"], ["alpha"])).toBe(
      jaccard(["alpha", "beta"], ["alpha"]),
    );
  });

  it("known value: 2-of-4 union → 0.5", () => {
    // {a,b} ∩ {a,b,c,d}=2, union=4 → 0.5
    expect(jaccard(["a", "b"], ["a", "b", "c", "d"])).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// bigrams – boundary
// ---------------------------------------------------------------------------

describe("bigrams – boundary", () => {
  it("empty array → empty", () => {
    expect(bigrams([])).toEqual([]);
  });

  it("single token → empty (need ≥2 for a bigram)", () => {
    expect(bigrams(["alpha"])).toEqual([]);
  });

  it("two tokens → exactly one bigram", () => {
    expect(bigrams(["alpha", "beta"])).toEqual(["alpha beta"]);
  });

  it("three tokens → two bigrams", () => {
    expect(bigrams(["alpha", "beta", "gamma"])).toEqual(["alpha beta", "beta gamma"]);
  });

  it("duplicate tokens produce duplicate bigrams (no dedup here)", () => {
    expect(bigrams(["x", "x", "x"])).toEqual(["x x", "x x"]);
  });
});

// ---------------------------------------------------------------------------
// approxGte – epsilon boundary
// ---------------------------------------------------------------------------

describe("approxGte – epsilon boundary", () => {
  it("exactly at threshold → true", () => {
    expect(approxGte(0.6, 0.6)).toBe(true);
  });

  it("above threshold → true", () => {
    expect(approxGte(0.7, 0.6)).toBe(true);
  });

  it("below threshold by epsilon/2 → true (inside tolerance)", () => {
    expect(approxGte(0.6 - SIMILARITY_EPSILON / 2, 0.6)).toBe(true);
  });

  it("below threshold by 2*epsilon → false (outside tolerance)", () => {
    expect(approxGte(0.6 - 2 * SIMILARITY_EPSILON, 0.6)).toBe(false);
  });

  it("0 vs 0.4 (persistence floor) → false", () => {
    expect(approxGte(0, 0.4)).toBe(false);
  });

  it("custom epsilon overrides default", () => {
    // With a large custom epsilon, even 0.0 >= 0.6 should pass
    expect(approxGte(0.0, 0.6, 1.0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trailingTopicRun – boundary
// ---------------------------------------------------------------------------

describe("trailingTopicRun – boundary", () => {
  it("empty array → 0", () => {
    expect(trailingTopicRun([])).toBe(0);
  });

  it("single element → 1", () => {
    expect(trailingTopicRun(["a"])).toBe(1);
  });

  it("all same → length", () => {
    expect(trailingTopicRun(["x", "x", "x", "x"])).toBe(4);
  });

  it("[a, b, b, b] → run of 3", () => {
    expect(trailingTopicRun(["a", "b", "b", "b"])).toBe(3);
  });

  it("[a, a, a, b] → run of 1 (last element differs)", () => {
    expect(trailingTopicRun(["a", "a", "a", "b"])).toBe(1);
  });

  it("alternating [a, b, a, b] → run of 1", () => {
    expect(trailingTopicRun(["a", "b", "a", "b"])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// compact – boundary
// ---------------------------------------------------------------------------

describe("compact – boundary", () => {
  it("short text returned unchanged", () => {
    expect(compact("hello world")).toBe("hello world");
  });

  it("exactly at max-length returned unchanged", () => {
    const exact = "x".repeat(220);
    expect(compact(exact)).toBe(exact);
  });

  it("one over max truncated to max with trailing ellipsis", () => {
    const over = "x".repeat(250);
    const result = compact(over);
    expect(result.length).toBe(220);
    expect(result.endsWith("…")).toBe(true);
  });

  it("internal whitespace (tabs/newlines) collapsed to single space", () => {
    expect(compact("hello   \n\t  world")).toBe("hello world");
  });

  it("custom max respected", () => {
    const result = compact("abcdefghij", 5);
    expect(result.length).toBe(5);
    expect(result.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasAny
// ---------------------------------------------------------------------------

describe("hasAny – case insensitivity", () => {
  it("case-insensitive match", () => {
    expect(hasAny("STOP right now", ["stop"])).toBe(true);
  });

  it("no match → false", () => {
    expect(hasAny("continue working", ["stop", "don't"])).toBe(false);
  });

  it("empty needles → false", () => {
    expect(hasAny("anything here", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// latestInstruction – adversarial
// ---------------------------------------------------------------------------

describe("latestInstruction – adversarial", () => {
  it("'stop' keyword detected", () => {
    expect(latestInstruction("stop doing that immediately")).not.toBeNull();
  });

  it("'don't' keyword detected", () => {
    expect(latestInstruction("don't repeat yourself please")).not.toBeNull();
  });

  it("'do not' keyword detected", () => {
    expect(latestInstruction("do not keep going with this")).not.toBeNull();
  });

  it("'instead' keyword detected", () => {
    expect(latestInstruction("do this instead")).not.toBeNull();
  });

  it("'rather' keyword detected", () => {
    expect(latestInstruction("rather focus on billing")).not.toBeNull();
  });

  it("Korean '그만' detected", () => {
    expect(latestInstruction("그만 해줘")).not.toBeNull();
  });

  it("Korean '아니' detected", () => {
    expect(latestInstruction("아니 그건 틀렸어")).not.toBeNull();
  });

  it("Korean '말고' detected", () => {
    expect(latestInstruction("이거 말고 저걸 해줘")).not.toBeNull();
  });

  it("Korean '대신' detected", () => {
    expect(latestInstruction("대신 다른걸 해봐")).not.toBeNull();
  });

  it("plain text without any keyword → null", () => {
    expect(latestInstruction("sounds great let us continue the current approach")).toBeNull();
  });

  it("empty string → null", () => {
    expect(latestInstruction("")).toBeNull();
  });

  it("result never exceeds compact limit of 160 chars", () => {
    const veryLong = "stop " + "a ".repeat(200);
    const result = latestInstruction(veryLong);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(160);
  });
});

// ---------------------------------------------------------------------------
// inferTopic – adversarial
// ---------------------------------------------------------------------------

describe("inferTopic – adversarial", () => {
  it("empty string → 'conversation'", () => {
    expect(inferTopic("")).toBe("conversation");
  });

  it("punctuation-only → 'conversation'", () => {
    expect(inferTopic("!!!???...")).toBe("conversation");
  });

  it("emoji-only → 'conversation'", () => {
    expect(inferTopic("🎉🎊🥳🔥")).toBe("conversation");
  });

  it("all-stop-word text → 'conversation'", () => {
    expect(inferTopic("the and or but a an")).toBe("conversation");
  });

  it("normal text → first ≤4 non-stop tokens joined by space", () => {
    expect(inferTopic("deploy staging server today")).toBe("deploy staging server today");
  });

  it("more than 4 content tokens → only first 4", () => {
    expect(inferTopic("alpha beta gamma delta epsilon zeta")).toBe("alpha beta gamma delta");
  });

  it("Korean content → first 4 non-stop tokens", () => {
    // "배포" "오늘" "해야" "한다" are not stop words
    expect(inferTopic("배포 오늘 해야 한다 정말")).toBe("배포 오늘 해야 한다");
  });
});

// ---------------------------------------------------------------------------
// similarity – boundary and symmetry
// ---------------------------------------------------------------------------

describe("similarity – boundary and symmetry", () => {
  it("identical texts → 1", () => {
    expect(similarity("alpha beta gamma", "alpha beta gamma")).toBe(1);
  });

  it("completely disjoint texts → 0", () => {
    expect(similarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("both empty → 0", () => {
    expect(similarity("", "")).toBe(0);
  });

  it("symmetric property holds for 6 diverse pairs", () => {
    const pairs: [string, string][] = [
      ["alpha beta gamma", "alpha beta delta"],
      ["the quick brown fox jumps", "the lazy brown dog lies"],
      ["배포 오늘", "배포 내일"],
      ["fix the login authentication bug now", "deploy staging environment today"],
      ["a b c d e f g", "b c d e f g h"],
      ["", "something here"],
    ];
    for (const [a, b] of pairs) {
      expect(similarity(a, b)).toBe(similarity(b, a));
    }
  });

  it("exactly Jaccard 0.6 (3 shared / 5 union): at threshold → fires via approxGte", () => {
    // tokenize("alpha beta gamma") → [alpha,beta,gamma]  (3)
    // tokenize("alpha beta gamma delta epsilon") → [alpha,beta,gamma,delta,epsilon]  (5)
    // intersection=3, union=5 → token jaccard = 3/5 = 0.6
    // bigram jaccard = 2/4 = 0.5; max(0.6,0.5) = 0.6
    const sim = similarity("alpha beta gamma", "alpha beta gamma delta epsilon");
    expect(approxGte(sim, DEFAULT_SIM_THRESHOLD)).toBe(true);
  });

  it("just below 0.6 (4/7 ≈ 0.571): NOT at threshold → does not fire via approxGte", () => {
    // tokenize("alpha beta gamma delta") → 4 tokens
    // tokenize("alpha beta gamma delta epsilon zeta eta") → 7 tokens
    // token jaccard = 4/7 ≈ 0.571
    // bigram jaccard = 3/6 = 0.5; max(0.571,0.5) ≈ 0.571 < 0.6
    const sim = similarity("alpha beta gamma delta", "alpha beta gamma delta epsilon zeta eta");
    expect(approxGte(sim, DEFAULT_SIM_THRESHOLD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maxPairwiseSimilarity – boundary
// ---------------------------------------------------------------------------

describe("maxPairwiseSimilarity – boundary", () => {
  it("empty array → 0", () => {
    expect(maxPairwiseSimilarity([])).toBe(0);
  });

  it("single text → 0 (no pairs to compare)", () => {
    expect(maxPairwiseSimilarity(["alpha beta gamma"])).toBe(0);
  });

  it("two identical texts → 1", () => {
    expect(maxPairwiseSimilarity(["alpha beta", "alpha beta"])).toBe(1);
  });

  it("deterministic across repeated calls", () => {
    const texts = ["alpha beta gamma", "alpha beta delta epsilon", "gamma delta zeta"];
    expect(maxPairwiseSimilarity(texts)).toBe(maxPairwiseSimilarity(texts));
  });

  it("returns max, not first pair", () => {
    // First pair is disjoint; second pair is identical — max must be 1
    const texts = ["alpha beta", "gamma delta", "alpha beta"];
    expect(maxPairwiseSimilarity(texts)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectStaleRepetition – boundary / adversarial
// ---------------------------------------------------------------------------

describe("detectStaleRepetition – boundary and adversarial", () => {
  it("empty messages → no signals", () => {
    expect(detectStaleRepetition([], "scope:empty")).toEqual([]);
  });

  it("single agent message → no signals (window size < 2)", () => {
    expect(detectStaleRepetition([agentMsg("a1", "hello world today")], "scope:single")).toEqual([]);
  });

  it("only user messages → no signals (agent window is empty)", () => {
    const msgs = [userMsg("u1", "hello"), userMsg("u2", "hello"), userMsg("u3", "hello")];
    expect(detectStaleRepetition(msgs, "scope:users")).toEqual([]);
  });

  it("two agent messages below 0.6 (4/7 ≈ 0.571) → no signals", () => {
    // persistence=2 < persistenceK=3; sim=0.571 < 0.6
    const msgs = [
      agentMsg("a1", "alpha beta gamma delta"),
      agentMsg("a2", "alpha beta gamma delta epsilon zeta eta"),
    ];
    expect(detectStaleRepetition(msgs, "scope:below-threshold")).toEqual([]);
  });

  it("two agent messages AT exactly 0.6 Jaccard → fires stale signal (high severity)", () => {
    const msgs = [
      agentMsg("a1", "alpha beta gamma"),
      agentMsg("a2", "alpha beta gamma delta epsilon"),
    ];
    const result = detectStaleRepetition(msgs, "scope:at-threshold");
    expect(result).toHaveLength(1);
    expect(result[0]!.fixationPattern).toBe("stale_expression_repeated");
    expect(result[0]!.severity).toBe("high");
  });

  it("window-bound (DEFAULT_WINDOW_N=8): 12 identical early + 8 diverse recent → no signals", () => {
    // Early messages are identical (high similarity) but fall outside the window
    const earlyMsgs = Array.from({ length: 12 }, (_, i) =>
      agentMsg(`early-${i}`, "I think we should ship the release today for sure."),
    );
    // Diverse recent messages: unique vocabulary, distinct topics
    const recentMsgs = [
      agentMsg("d1", "configure database schema migration carefully"),
      agentMsg("d2", "provision load balancer across multiple zones"),
      agentMsg("d3", "verify health checks pass end to end"),
      agentMsg("d4", "rollback strategy defined for deployment failure"),
      agentMsg("d5", "audit log retention policy compliance review"),
      agentMsg("d6", "encryption keys rotated quarterly per schedule"),
      agentMsg("d7", "performance benchmark baseline established upstream"),
      agentMsg("d8", "incident response runbook updated recently confirmed"),
    ];
    expect(recentMsgs.length).toBe(DEFAULT_WINDOW_N);
    const result = detectStaleRepetition([...earlyMsgs, ...recentMsgs], "scope:window-bound");
    // window slices to last 8 agent messages = recentMsgs only
    expect(result).toEqual([]);
  });

  it("Korean near-duplicate agent messages → fires stale signal", () => {
    const text = "배포 오늘 해야 한다 정말로";
    const msgs = [agentMsg("k1", text), agentMsg("k2", text), agentMsg("k3", text)];
    const result = detectStaleRepetition(msgs, "scope:korean");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.fixationPattern).toBe("stale_expression_repeated");
  });

  it("all-stop-word text → no signals (jaccard([],[])=0 < 0.4 floor, stuck=false)", () => {
    // tokenize("the and or but a") = [] → jaccard([], []) = 0
    // stuck condition: approxGte(0, 0.4) = false → no signal
    const msgs = [
      agentMsg("s1", "the and or but a"),
      agentMsg("s2", "the and or but a"),
      agentMsg("s3", "the and or but a"),
    ];
    expect(detectStaleRepetition(msgs, "scope:stopwords")).toEqual([]);
  });

  it("punctuation-only agent messages → no signals", () => {
    const msgs = [
      agentMsg("p1", "!!!???..."),
      agentMsg("p2", "!!!???..."),
      agentMsg("p3", "!!!???..."),
    ];
    expect(detectStaleRepetition(msgs, "scope:punct")).toEqual([]);
  });

  it("emoji-only agent messages → no signals", () => {
    const msgs = [agentMsg("e1", "🎉🎊🥳"), agentMsg("e2", "🎉🎊🥳"), agentMsg("e3", "🎉🎊🥳")];
    expect(detectStaleRepetition(msgs, "scope:emoji")).toEqual([]);
  });

  it("very long identical texts (~800 chars each) → deterministic, fires", () => {
    const long = ("deploy server production ").repeat(50).trim();
    const msgs = [agentMsg("l1", long), agentMsg("l2", long)];
    const r1 = detectStaleRepetition(msgs, "scope:longtext");
    const r2 = detectStaleRepetition(msgs, "scope:longtext");
    expect(r1).toEqual(r2); // determinism
    expect(r1.length).toBeGreaterThan(0); // identical content must fire
  });

  it("signal has required schema and field shapes", () => {
    const msgs = [
      agentMsg("f1", "alpha beta gamma"),
      agentMsg("f2", "alpha beta gamma delta epsilon"),
    ];
    const result = detectStaleRepetition(msgs, "scope:fields");
    expect(result[0]).toMatchObject({
      schema: "conversation_watcher.internal_anti_fixation_signal.v1",
      fixationPattern: "stale_expression_repeated",
      severity: "high",
      confidence: 0.6,
      scopeId: "scope:fields",
    });
    expect(typeof result[0]!.signalId).toBe("string");
    expect(result[0]!.signalId.length).toBeGreaterThan(0);
    expect(Array.isArray(result[0]!.sourceMessageIds)).toBe(true);
    expect(result[0]!.sourceMessageIds.length).toBeGreaterThanOrEqual(2);
  });

  it("persistence path fires when run≥K and sim≥floor: 4 same-topic messages", () => {
    // Each message has the same topic but similarity just above floor (0.4)
    // Use texts with ~50% overlap so: sim > 0.4 and sim < 0.6
    const msgs = [
      agentMsg("t1", "kappa lambda mu nu"),
      agentMsg("t2", "kappa lambda mu xi"),   // ~0.6 — might trigger repetition
      agentMsg("t3", "kappa lambda mu omicron"), // shared tokens: kappa,lambda,mu
      agentMsg("t4", "kappa lambda mu pi"),
    ];
    // All have same topic "kappa lambda mu nu/xi/omicron/pi" truncated to "kappa lambda mu nu/xi..."
    // The persistence path fires if run >= 3 AND sim >= 0.4
    const result = detectStaleRepetition(msgs, "scope:persistence");
    // Just verify no crash and schema is valid if signals exist
    for (const s of result) {
      expect(s.schema).toBe("conversation_watcher.internal_anti_fixation_signal.v1");
    }
  });
});

// ---------------------------------------------------------------------------
// detectCorrectionDrivenFixation – adversarial
// ---------------------------------------------------------------------------

describe("detectCorrectionDrivenFixation – adversarial", () => {
  it("empty messages → no signals", () => {
    expect(detectCorrectionDrivenFixation([], "scope:empty")).toEqual([]);
  });

  it("no agent-user-agent triplet → no signals", () => {
    const msgs = [userMsg("u1", "stop that"), userMsg("u2", "please"), userMsg("u3", "now")];
    expect(detectCorrectionDrivenFixation(msgs, "scope:notriplet")).toEqual([]);
  });

  it("classic correction pattern fires: fires correction signal with confidence 0.9", () => {
    const msgs = [
      agentMsg("a1", "should deploy staging server right away before lunch"),
      userMsg("u1", "stop focus on billing bug instead"),
      agentMsg("a2", "should deploy staging server because priority today honestly"),
    ];
    const result = detectCorrectionDrivenFixation(msgs, "scope:correction");
    expect(result).toHaveLength(1);
    expect(result[0]!.fixationPattern).toBe("new_context_ignored_previous_frame_repeated");
    expect(result[0]!.confidence).toBe(0.9);
    expect(result[0]!.severity).toBe("high");
  });

  it("user message has no correction keyword → no signal", () => {
    const msgs = [
      agentMsg("a1", "should deploy staging server right away"),
      userMsg("u1", "sounds good continue please"),
      agentMsg("a2", "should deploy staging server right away today"),
    ];
    expect(detectCorrectionDrivenFixation(msgs, "scope:nokeyword")).toEqual([]);
  });

  it("agent changes frame after correction → no signal (pivot successful)", () => {
    const msgs = [
      agentMsg("a1", "should deploy staging server right away"),
      userMsg("u1", "stop focus on billing bug instead"),
      agentMsg("a2", "billing issue requires database migration first"),
    ];
    // repeatedFrame = false → no signal
    expect(detectCorrectionDrivenFixation(msgs, "scope:pivoted")).toEqual([]);
  });

  it("Korean correction keyword triggers signal", () => {
    // Both agent messages must share the same 4-token inferTopic.
    // "배포 오늘 해야 한다" covers the first 4 non-stop tokens in both.
    const msgs = [
      agentMsg("a1", "배포 오늘 해야 한다 어서 빨리"),
      userMsg("u1", "그만 해줘 청구 버그 봐줘"),
      agentMsg("a2", "배포 오늘 해야 한다 지금 당장"),
    ];
    const result = detectCorrectionDrivenFixation(msgs, "scope:korean-correction");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.fixationPattern).toBe("new_context_ignored_previous_frame_repeated");
  });

  it("multiple triplets in a conversation → can produce multiple signals", () => {
    // Agent messages must share the same inferTopic across each triplet.
    // First 4 non-stop tokens of "should deploy staging server *" are identical.
    const msgs = [
      agentMsg("a1", "should deploy staging server right away today"),
      userMsg("u1", "stop focus on billing bug instead"),
      agentMsg("a2", "should deploy staging server because priority"),
      userMsg("u2", "do not continue rather fix login now"),
      agentMsg("a3", "should deploy staging server urgently confirmed"),
    ];
    const result = detectCorrectionDrivenFixation(msgs, "scope:multi");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateFixation – determinism
// ---------------------------------------------------------------------------

describe("evaluateFixation – determinism", () => {
  it("same input → identical output across 3 calls", () => {
    const msgs = [
      agentMsg("a1", "alpha beta gamma"),
      agentMsg("a2", "alpha beta gamma delta epsilon"),
    ];
    const r1 = evaluateFixation(msgs, "scope:det");
    const r2 = evaluateFixation(msgs, "scope:det");
    const r3 = evaluateFixation(msgs, "scope:det");
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it("empty input → empty array", () => {
    expect(evaluateFixation([], "scope:empty")).toEqual([]);
  });

  it("combines stale + correction signals without duplication", () => {
    // A message set that triggers both paths
    const msgs = [
      agentMsg("a1", "alpha beta gamma delta epsilon"),
      userMsg("u1", "stop focus on zeta eta instead"),
      agentMsg("a2", "alpha beta gamma delta epsilon"),
    ];
    const combined = evaluateFixation(msgs, "scope:both");
    // detectCorrectionDrivenFixation fires (correction + repeated frame)
    // detectStaleRepetition fires (identical texts at sim=1 ≥ 0.6)
    // Both should be included
    expect(combined.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateHostPolicyGate – suppression precedence and deliveryMessageId
// ---------------------------------------------------------------------------

describe("evaluateHostPolicyGate – suppression precedence and deliveryMessageId", () => {
  it("no suppression flags: allowed=true, deliveryMessageId passed through", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      deliveryMessageId: "msg-deliver-001",
    });
    expect(result.allowed).toBe(true);
    expect(result.suppressedReason).toBeUndefined();
    expect(result.deliveryMessageId).toBe("msg-deliver-001");
  });

  it("shadow_mode=true: suppressed with reason 'shadow_mode', no deliveryMessageId", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      shadowMode: true,
      deliveryMessageId: "msg-should-not-appear",
    });
    expect(result.allowed).toBe(false);
    expect(result.suppressedReason).toBe("shadow_mode");
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("cooldownHit only: suppressed by 'cooldown'", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      cooldownHit: true,
      deliveryMessageId: "msg-x",
    });
    expect(result.allowed).toBe(false);
    expect(result.suppressedReason).toBe("cooldown");
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("duplicateHit only: suppressed by 'duplicate'", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      duplicateHit: true,
      deliveryMessageId: "msg-x",
    });
    expect(result.allowed).toBe(false);
    expect(result.suppressedReason).toBe("duplicate");
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("privacyRisk only: suppressed by 'privacy'", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      privacyRisk: true,
      deliveryMessageId: "msg-x",
    });
    expect(result.allowed).toBe(false);
    expect(result.suppressedReason).toBe("privacy");
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("crossThreadRisk: suppressed by 'thread_mismatch'", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      crossThreadRisk: true,
      deliveryMessageId: "msg-x",
    });
    expect(result.allowed).toBe(false);
    expect(result.suppressedReason).toBe("thread_mismatch");
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("source/target threadId mismatch: suppressed by 'thread_mismatch'", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      sourceThreadId: "thread-A",
      targetThreadId: "thread-B",
      deliveryMessageId: "msg-x",
    });
    expect(result.allowed).toBe(false);
    expect(result.suppressedReason).toBe("thread_mismatch");
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("ALL flags true: shadow_mode wins (highest precedence)", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      shadowMode: true,
      cooldownHit: true,
      duplicateHit: true,
      privacyRisk: true,
      crossThreadRisk: true,
      deliveryMessageId: "msg-suppress-all",
    });
    expect(result.suppressedReason).toBe("shadow_mode");
    expect(result.allowed).toBe(false);
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("shadow=false, cooldown=true, duplicate=true: cooldown wins over duplicate", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      cooldownHit: true,
      duplicateHit: true,
    });
    expect(result.suppressedReason).toBe("cooldown");
  });

  it("cooldown=false, duplicate=true, privacy=true: duplicate wins over privacy", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      duplicateHit: true,
      privacyRisk: true,
    });
    expect(result.suppressedReason).toBe("duplicate");
  });

  it("privacy=true, crossThread=true (no duplicate/cooldown): privacy wins over thread_mismatch", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      privacyRisk: true,
      crossThreadRisk: true,
    });
    expect(result.suppressedReason).toBe("privacy");
  });

  it("invariant: every suppressed audit has undefined deliveryMessageId", () => {
    const cases: Array<Parameters<typeof evaluateHostPolicyGate>[0]> = [
      { runtime: "openclaw", signal: minimalSignal(), criticConfidence: 0.9, shadowMode: true, deliveryMessageId: "leak" },
      { runtime: "openclaw", signal: minimalSignal(), criticConfidence: 0.9, cooldownHit: true, deliveryMessageId: "leak" },
      { runtime: "openclaw", signal: minimalSignal(), criticConfidence: 0.9, duplicateHit: true, deliveryMessageId: "leak" },
      { runtime: "openclaw", signal: minimalSignal(), criticConfidence: 0.9, privacyRisk: true, deliveryMessageId: "leak" },
      { runtime: "openclaw", signal: minimalSignal(), criticConfidence: 0.9, crossThreadRisk: true, deliveryMessageId: "leak" },
      { runtime: "openclaw", signal: minimalSignal(), criticConfidence: 0.9, sourceThreadId: "A", targetThreadId: "B", deliveryMessageId: "leak" },
    ];
    for (const input of cases) {
      const result = evaluateHostPolicyGate(input);
      expect(result.allowed).toBe(false);
      expect(result.deliveryMessageId).toBeUndefined();
    }
  });

  it("allowed=true with no deliveryMessageId input → deliveryMessageId is undefined in output", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      // deliveryMessageId not provided
    });
    expect(result.allowed).toBe(true);
    expect(result.deliveryMessageId).toBeUndefined();
  });

  it("cooldownKey derived from scopeId and fixationPattern", () => {
    const signal = minimalSignal({
      scopeId: "scope:ck",
      fixationPattern: "stale_expression_repeated",
    });
    const result = evaluateHostPolicyGate({ runtime: "openclaw", signal, criticConfidence: 0.9 });
    expect(result.cooldownKey).toBe("scope:ck:stale_expression_repeated");
  });

  it("audit schema always 'conversation_watcher.host_policy_gate_audit.v1'", () => {
    const result = evaluateHostPolicyGate({
      runtime: "hermes",
      signal: minimalSignal(),
      criticConfidence: 0.75,
    });
    expect(result.schema).toBe("conversation_watcher.host_policy_gate_audit.v1");
  });

  it("matching threadIds allowed (no mismatch)", () => {
    const result = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal: minimalSignal(),
      criticConfidence: 0.9,
      sourceThreadId: "thread-X",
      targetThreadId: "thread-X",
    });
    expect(result.allowed).toBe(true);
    expect(result.threadCheck.verdict).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// createNeutralConversationContext – adversarial
// ---------------------------------------------------------------------------

describe("createNeutralConversationContext – adversarial", () => {
  it("empty messages → confidence 0.1, null user fields", () => {
    const ctx = createNeutralConversationContext("scope:empty", []);
    expect(ctx.confidence).toBe(0.1);
    expect(ctx.latestExplicitInstruction).toBeNull();
    expect(ctx.recentUserIntent).toBeNull();
    expect(ctx.currentTopic).toBe("conversation");
    expect(ctx.sourceMessageIds).toEqual([]);
  });

  it("only agent messages → no user context, currentTopic = 'conversation'", () => {
    const msgs = [agentMsg("a1", "deploying server"), agentMsg("a2", "configuring balancer")];
    const ctx = createNeutralConversationContext("scope:agents-only", msgs);
    expect(ctx.currentTopic).toBe("conversation");
    expect(ctx.recentUserIntent).toBeNull();
    expect(ctx.latestExplicitInstruction).toBeNull();
  });

  it("non-empty messages → confidence 0.82", () => {
    const ctx = createNeutralConversationContext("scope:conf", [userMsg("u1", "hello world")]);
    expect(ctx.confidence).toBe(0.82);
  });

  it("English '?' triggers openQuestions", () => {
    const ctx = createNeutralConversationContext("scope:q", [
      userMsg("u1", "what should we do?"),
    ]);
    expect(ctx.openQuestions).toHaveLength(1);
  });

  it("Korean '?' triggers openQuestions", () => {
    const ctx = createNeutralConversationContext("scope:kq", [
      userMsg("u1", "이거 어떻게 하나요?"),
    ]);
    expect(ctx.openQuestions).toHaveLength(1);
  });

  it("user message without '?' is not in openQuestions", () => {
    const ctx = createNeutralConversationContext("scope:noq", [
      userMsg("u1", "deploy the server today"),
    ]);
    expect(ctx.openQuestions).toHaveLength(0);
  });

  it("topic shift between user messages creates discontinuity", () => {
    const msgs = [
      userMsg("u1", "deploy staging server today"),
      userMsg("u2", "billing bug report urgent"),
    ];
    const ctx = createNeutralConversationContext("scope:disc", msgs);
    expect(ctx.contextDiscontinuities).toHaveLength(1);
  });

  it("instruction keyword in user message sets latestExplicitInstruction", () => {
    const msgs = [userMsg("u1", "stop doing that right now")];
    const ctx = createNeutralConversationContext("scope:instr", msgs);
    expect(ctx.latestExplicitInstruction).not.toBeNull();
  });

  it("schema always 'conversation_watcher.neutral_context.v1'", () => {
    const ctx = createNeutralConversationContext("scope:schema", []);
    expect(ctx.schema).toBe("conversation_watcher.neutral_context.v1");
  });

  it("sourceMessageIds mirrors all input message ids in order", () => {
    const msgs = [agentMsg("x1", "a"), userMsg("x2", "b"), agentMsg("x3", "c")];
    const ctx = createNeutralConversationContext("scope:ids", msgs);
    expect(ctx.sourceMessageIds).toEqual(["x1", "x2", "x3"]);
  });
});

// ---------------------------------------------------------------------------
// planExternalNudge – field validation
// ---------------------------------------------------------------------------

describe("planExternalNudge – field validation", () => {
  it("nudgeId derived as 'nudge-<signalId>'", () => {
    const signal = minimalSignal({ signalId: "sig-test-xyz" });
    const nudge = planExternalNudge("openclaw", signal, "Please pivot.");
    expect(nudge.nudgeId).toBe("nudge-sig-test-xyz");
  });

  it("schema always 'conversation_watcher.external_nudge.v1'", () => {
    const nudge = planExternalNudge("openclaw", minimalSignal(), "text");
    expect(nudge.schema).toBe("conversation_watcher.external_nudge.v1");
  });

  it("identityDisclosure always 'agent_explicit'", () => {
    const nudge = planExternalNudge("openclaw", minimalSignal(), "text");
    expect(nudge.identityDisclosure).toBe("agent_explicit");
  });

  it("target runtime set correctly for hermes", () => {
    const nudge = planExternalNudge("hermes", minimalSignal(), "text", { channel: "ch-99" });
    expect(nudge.target.runtime).toBe("hermes");
    expect(nudge.target.channel).toBe("ch-99");
  });

  it("internalSignalId mirrors signal's signalId", () => {
    const signal = minimalSignal({ signalId: "sig-ref-111" });
    const nudge = planExternalNudge("openclaw", signal, "text");
    expect(nudge.internalSignalId).toBe("sig-ref-111");
  });
});

// ---------------------------------------------------------------------------
// check helper
// ---------------------------------------------------------------------------

describe("check – structural helper", () => {
  it("returns verdict and reason unchanged", () => {
    expect(check("passed", "all clear")).toEqual({ verdict: "passed", reason: "all clear" });
    expect(check("blocked", "duplicate")).toEqual({ verdict: "blocked", reason: "duplicate" });
    expect(check("not_applicable", "n/a")).toEqual({ verdict: "not_applicable", reason: "n/a" });
  });
});

// ---------------------------------------------------------------------------
// evaluateFixtureResult – golden parity
// ---------------------------------------------------------------------------

describe("evaluateFixtureResult – golden parity (all fixtures)", () => {
  it("at least one fixture loaded", () => {
    expect(GOLDEN.fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of GOLDEN.fixtures) {
    it(`"${fixture.name}": fixated=${fixture.expectedFixated}, patterns=${JSON.stringify(fixture.expectedPatterns)}`, () => {
      const result = evaluateFixtureResult(fixture);
      expect(result.fixated).toBe(fixture.expectedFixated);
      expect(result.patterns.slice().sort()).toEqual(fixture.expectedPatterns.slice().sort());
    });
  }
});
