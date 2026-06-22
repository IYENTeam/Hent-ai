import { describe, expect, it } from "vitest";
import { loadConversationConfigFromEnv } from "./conversation-config.js";

describe("conversation config defaults", () => {
  it("keeps service-owned conversation disabled with exact defaults when env is absent", () => {
    // Given: no conversation env overrides are present.
    const env = {};

    // When: the service loads conversation config.
    const config = loadConversationConfigFromEnv(env);

    // Then: ambient conversation remains disabled and defaults are stable.
    expect(config).toEqual({
      enabled: false,
      rawRetentionDays: 14,
      minDelayMs: 650,
      maxDelayMs: 6500,
      maxChunks: 4,
      maxChunkChars: 1800,
      cooldownMs: 600_000,
      budgetPerHour: 20,
      minHumanIdleMs: 12_000,
      confidenceThreshold: 0.7,
      diagnostics: [],
    });
  });

  it("fails closed with diagnostics when env values are malformed", () => {
    // Given: conversation is requested, but service-owned env config is malformed.
    const env = {
      HENT_AI_CONVERSATION_ENABLED: "true",
      HENT_AI_CONVERSATION_RAW_RETENTION_DAYS: "0",
      HENT_AI_CONVERSATION_MIN_DELAY_MS: "7000",
      HENT_AI_CONVERSATION_MAX_DELAY_MS: "650",
    };

    // When: the service parses the env boundary.
    const config = loadConversationConfigFromEnv(env);

    // Then: the feature remains disabled and reports actionable diagnostics.
    expect(config.enabled).toBe(false);
    expect(config.diagnostics).toEqual([
      "HENT_AI_CONVERSATION_RAW_RETENTION_DAYS must be a positive integer",
      "HENT_AI_CONVERSATION_MAX_DELAY_MS must be greater than or equal to HENT_AI_CONVERSATION_MIN_DELAY_MS",
    ]);
  });

  it("enables conversation only when every service env override is valid", () => {
    // Given: every supported conversation env override is valid.
    const env = {
      HENT_AI_CONVERSATION_ENABLED: "1",
      HENT_AI_CONVERSATION_RAW_RETENTION_DAYS: "30",
      HENT_AI_CONVERSATION_MIN_DELAY_MS: "750",
      HENT_AI_CONVERSATION_MAX_DELAY_MS: "3000",
    };

    // When: the service loads conversation config.
    const config = loadConversationConfigFromEnv(env);

    // Then: opt-in succeeds without invoking any provider or network boundary.
    expect(config).toMatchObject({
      enabled: true,
      rawRetentionDays: 30,
      minDelayMs: 750,
      maxDelayMs: 3000,
      diagnostics: [],
    });
  });
});
