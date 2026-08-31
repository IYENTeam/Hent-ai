import { describe, expect, it, vi } from "vitest";
import {
  buildCriticPrompt,
  buildGenerationPrompt,
  createWatcherLlm,
  moderateNudge,
  parseCriticResponse,
  MAX_NUDGE_CHARS,
} from "./watcher-llm.js";
import type { InternalAntiFixationSignal, NeutralConversationContext } from "./watcher-core.js";

const context: NeutralConversationContext = {
  schema: "conversation_watcher.neutral_context.v1",
  scopeId: "channel:1",
  sourceMessageIds: ["a", "b"],
  currentTopic: "deploy staging server",
  latestExplicitInstruction: null,
  recentUserIntent: null,
  openQuestions: [],
  contextDiscontinuities: [],
  summary: "s",
  confidence: 0.82,
  createdAt: "t",
};

const signal: InternalAntiFixationSignal = {
  schema: "conversation_watcher.internal_anti_fixation_signal.v1",
  signalId: "sig-1",
  scopeId: "channel:1",
  reason: "r",
  staleFrame: "deploy staging server",
  newContextEvidence: "e",
  suggestedPivot: "Try discussing the rollout risks instead.",
  sourceMessageIds: ["a"],
  confidence: 0.6,
  severity: "high",
  fixationPattern: "stale_expression_repeated",
  createdAt: "t",
};

describe("buildCriticPrompt", () => {
  it("includes the current topic and the last recent turns", () => {
    const prompt = buildCriticPrompt(context, ["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(prompt).toContain("deploy staging server");
    expect(prompt).toContain("t6");
    expect(prompt).not.toContain("t1"); // only the last 5 are kept
  });
});

describe("parseCriticResponse", () => {
  it("returns null for null / no-brace / unbalanced / parse-fail", () => {
    expect(parseCriticResponse(null)).toBeNull();
    expect(parseCriticResponse("no json here")).toBeNull();
    expect(parseCriticResponse("{ no closing brace")).toBeNull();
    expect(parseCriticResponse("}{")).toBeNull();
    expect(parseCriticResponse("{bad json}")).toBeNull();
  });

  it("returns null when fields are missing or mistyped", () => {
    expect(parseCriticResponse('{"fixated":"yes","confidence":0.9}')).toBeNull();
    expect(parseCriticResponse('{"fixated":true,"confidence":"high"}')).toBeNull();
  });

  it("returns null when confidence is out of range", () => {
    expect(parseCriticResponse('{"fixated":true,"confidence":1.5}')).toBeNull();
    expect(parseCriticResponse('{"fixated":true,"confidence":-0.1}')).toBeNull();
  });

  it("parses a valid response, tolerating surrounding text", () => {
    expect(parseCriticResponse('{"fixated":true,"confidence":0.8}')).toEqual({ fixated: true, confidence: 0.8 });
    expect(parseCriticResponse('here: {"fixated":false,"confidence":0.2} done')).toEqual({
      fixated: false,
      confidence: 0.2,
    });
  });
});

describe("buildGenerationPrompt", () => {
  it("omits persona when not provided and prepends it when provided", () => {
    expect(buildGenerationPrompt(signal, context).system).not.toContain("PERSONA");
    const withPersona = buildGenerationPrompt(signal, context, "PERSONA: gothic idol");
    expect(withPersona.system.startsWith("PERSONA: gothic idol")).toBe(true);
    expect(withPersona.user).toContain("deploy staging server");
  });
});

describe("moderateNudge", () => {
  it("accepts a clean short nudge", () => {
    expect(moderateNudge("Maybe pivot to the rollout risks?")).toBe(true);
  });

  it("rejects empty, whitespace, and over-length nudges", () => {
    expect(moderateNudge("")).toBe(false);
    expect(moderateNudge("   ")).toBe(false);
    expect(moderateNudge("x".repeat(MAX_NUDGE_CHARS + 1))).toBe(false);
  });

  it("rejects links, mass mentions, and media injection", () => {
    expect(moderateNudge("check https://evil.example")).toBe(false);
    expect(moderateNudge("@everyone look here")).toBe(false);
    expect(moderateNudge("MEDIA:/etc/passwd")).toBe(false);
  });
});

describe("createWatcherLlm", () => {
  it("critic parses chat JSON and fail-closes on null chat", async () => {
    const llm = createWatcherLlm(vi.fn(async () => '{"fixated":true,"confidence":0.9}'));
    expect(await llm.critic({ signal, context, recentTexts: ["a"] })).toEqual({ fixated: true, confidence: 0.9 });
    const nullLlm = createWatcherLlm(vi.fn(async () => null));
    expect(await nullLlm.critic({ signal, context, recentTexts: ["a"] })).toBeNull();
  });

  it("generate trims text and returns null for empty/whitespace/null", async () => {
    const llm = createWatcherLlm(vi.fn(async () => "  Pivot now.  "), "PERSONA");
    expect(await llm.generate({ signal, context })).toBe("Pivot now.");
    expect(await createWatcherLlm(vi.fn(async () => "   ")).generate({ signal, context })).toBeNull();
    expect(await createWatcherLlm(vi.fn(async () => null)).generate({ signal, context })).toBeNull();
  });

  it("moderate delegates to moderateNudge", () => {
    const llm = createWatcherLlm(vi.fn(async () => null));
    expect(llm.moderate("clean line")).toBe(true);
    expect(llm.moderate("@here spam")).toBe(false);
  });
});
