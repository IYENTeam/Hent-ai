import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG, type ConversationServiceConfig } from "./conversation-config.js";
import {
  GENERIC_CONVERSATION_PERSONA,
  evaluateConversationSpeechPolicy,
  type ConversationSpeechPolicyInput,
  type ConversationSuppressedReason,
} from "./conversation-speech-policy.js";

const nowMs = 1_797_840_000_000;

function enabledConfig(overrides: Partial<ConversationServiceConfig> = {}): ConversationServiceConfig {
  return {
    ...DEFAULT_CONVERSATION_CONFIG,
    enabled: true,
    ...overrides,
  };
}

function allowedInput(overrides: Partial<ConversationSpeechPolicyInput> = {}): ConversationSpeechPolicyInput {
  return {
    config: enabledConfig(),
    channel: { enabled: true },
    profile: { soulSnippet: "Speak as a concise deployment guide." },
    state: {
      lastSpeechAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.cooldownMs - 1,
      speechCountThisHour: 0,
      lastHumanMessageAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.minHumanIdleMs - 1,
    },
    provider: { confidence: 0.9 },
    safeguards: {
      privacyAllowed: true,
      threadAllowed: true,
      duplicateTurn: false,
      selfEcho: false,
    },
    nowMs,
    ...overrides,
  };
}

function expectSuppressed(input: ConversationSpeechPolicyInput, reason: ConversationSuppressedReason): void {
  // Given: one policy gate is failing in an otherwise speakable room.
  const evaluatedInput = input;

  // When: the service evaluates ambient speech policy.
  const result = evaluateConversationSpeechPolicy(evaluatedInput);

  // Then: the service suppresses speech with the exact gate reason.
  expect(result).toEqual({ allowed: false, suppressedReason: reason });
}

describe("conversation speech policy", () => {
  it("allows speech and resolves channel profile persona when every gate passes", () => {
    // Given: conversation is globally and channel enabled with all policy gates passing.
    const input = allowedInput();

    // When: the service evaluates ambient speech policy.
    const result = evaluateConversationSpeechPolicy(input);

    // Then: it allows a speak decision using the channel profile persona.
    expect(result).toEqual({
      allowed: true,
      persona: {
        source: "channel_profile",
        text: "You are HentAI, a concise bot presence. Never claim to be human. Persona notes: Speak as a concise deployment guide.",
      },
      budgetRemaining: DEFAULT_CONVERSATION_CONFIG.budgetPerHour - 1,
    });
  });

  it("suppresses when service conversation is disabled", () => {
    expectSuppressed(allowedInput({ config: enabledConfig({ enabled: false }) }), "service_disabled");
  });

  it("suppresses when the channel has not opted in", () => {
    expectSuppressed(allowedInput({ channel: { enabled: null } }), "channel_disabled");
  });

  it("suppresses during cooldown", () => {
    expectSuppressed(
      allowedInput({
        state: {
          lastSpeechAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.cooldownMs + 1,
          speechCountThisHour: 0,
          lastHumanMessageAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.minHumanIdleMs - 1,
        },
      }),
      "cooldown",
    );
  });

  it("suppresses when the hourly budget is exhausted", () => {
    expectSuppressed(
      allowedInput({
        state: {
          lastSpeechAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.cooldownMs - 1,
          speechCountThisHour: DEFAULT_CONVERSATION_CONFIG.budgetPerHour,
          lastHumanMessageAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.minHumanIdleMs - 1,
        },
      }),
      "hourly_budget_exhausted",
    );
  });

  it("suppresses when humans are not idle long enough", () => {
    expectSuppressed(
      allowedInput({
        state: {
          lastSpeechAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.cooldownMs - 1,
          speechCountThisHour: 0,
          lastHumanMessageAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.minHumanIdleMs + 1,
        },
      }),
      "recent_human_active",
    );
  });

  it("suppresses when there is no recent human activity timestamp", () => {
    expectSuppressed(
      allowedInput({
        state: {
          lastSpeechAtMs: nowMs - DEFAULT_CONVERSATION_CONFIG.cooldownMs - 1,
          speechCountThisHour: 0,
          lastHumanMessageAtMs: null,
        },
      }),
      "no_recent_human_activity",
    );
  });

  it("suppresses low-confidence provider decisions", () => {
    expectSuppressed(allowedInput({ provider: { confidence: DEFAULT_CONVERSATION_CONFIG.confidenceThreshold - 0.01 } }), "low_confidence");
  });

  it("suppresses when privacy policy disallows ambient speech", () => {
    expectSuppressed(
      allowedInput({
        safeguards: {
          privacyAllowed: false,
          threadAllowed: true,
          duplicateTurn: false,
          selfEcho: false,
        },
      }),
      "privacy_blocked",
    );
  });

  it("suppresses when the thread policy disallows ambient speech", () => {
    expectSuppressed(
      allowedInput({
        safeguards: {
          privacyAllowed: true,
          threadAllowed: false,
          duplicateTurn: false,
          selfEcho: false,
        },
      }),
      "thread_blocked",
    );
  });

  it("suppresses duplicate turns", () => {
    expectSuppressed(
      allowedInput({
        safeguards: {
          privacyAllowed: true,
          threadAllowed: true,
          duplicateTurn: true,
          selfEcho: false,
        },
      }),
      "duplicate_turn",
    );
  });

  it("suppresses self echoes", () => {
    expectSuppressed(
      allowedInput({
        safeguards: {
          privacyAllowed: true,
          threadAllowed: true,
          duplicateTurn: false,
          selfEcho: true,
        },
      }),
      "self_echo",
    );
  });

  it("resolves configured persona before the generic fallback", () => {
    // Given: no channel profile persona exists, but service config has a persona.
    const input = allowedInput({
      config: enabledConfig({ persona: "Prefer short operational replies." }),
      profile: { soulSnippet: null },
    });

    // When: the service evaluates ambient speech policy.
    const result = evaluateConversationSpeechPolicy(input);

    // Then: the configured persona wins over the generic fallback.
    expect(result).toMatchObject({
      allowed: true,
      persona: {
        source: "config",
        text: "You are HentAI, a concise bot presence. Never claim to be human. Persona notes: Prefer short operational replies.",
      },
    });
  });

  it("uses a generic concise bot persona when profile and config persona are absent", () => {
    // Given: no profile or configured persona is available.
    const input = allowedInput({ profile: undefined });

    // When: the service evaluates ambient speech policy.
    const result = evaluateConversationSpeechPolicy(input);

    // Then: speech still uses a generic bot persona that does not claim human identity.
    expect(result).toMatchObject({
      allowed: true,
      persona: { source: "generic", text: GENERIC_CONVERSATION_PERSONA },
    });
  });

  it("strips human-identity claims from selected persona notes", () => {
    // Given: the selected channel persona tries to claim human identity.
    const input = allowedInput({ profile: { soulSnippet: "I am a real human, not a bot. Keep replies short." } });

    // When: the service evaluates ambient speech policy.
    const result = evaluateConversationSpeechPolicy(input);

    // Then: the service keeps the profile precedence but removes identity claims.
    expect(result).toMatchObject({
      allowed: true,
      persona: {
        source: "channel_profile",
        text: "You are HentAI, a concise bot presence. Never claim to be human. Persona notes: Keep replies short.",
      },
    });
  });

  it("strips person and not-robot identity claims from selected persona notes", () => {
    // Given: the selected channel persona uses a human/person identity claim.
    const input = allowedInput({ profile: { soulSnippet: "I am a person, not a robot. Keep replies short." } });

    // When: the service evaluates ambient speech policy.
    const result = evaluateConversationSpeechPolicy(input);

    // Then: the final persona preserves useful style guidance without identity claims.
    expect(result).toMatchObject({
      allowed: true,
      persona: {
        source: "channel_profile",
        text: "You are HentAI, a concise bot presence. Never claim to be human. Persona notes: Keep replies short.",
      },
    });
  });
});
