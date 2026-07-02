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
      maxChunks: 5,
      maxChunkChars: 140,
      cooldownMs: 600_000,
      budgetPerHour: 20,
      minHumanIdleMs: 12_000,
      confidenceThreshold: 0.7,
      recentTurnWindow: 24,
      contextRefreshEnabled: true,
      compactionIntervalMs: 21_600_000,
      defaultChannelEnabled: true,
      basePauseMs: 400,
      perCharMs: 55,
      maxDeliveryAttempts: 3,
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
      HENT_AI_CONVERSATION_RECENT_TURNS: "nope",
      HENT_AI_CONVERSATION_CONTEXT_REFRESH: "sometimes",
      HENT_AI_CONVERSATION_PER_CHAR_MS: "-1",
      HENT_AI_CONVERSATION_MAX_DELIVERY_ATTEMPTS: "0",
    };

    // When: the service parses the env boundary.
    const config = loadConversationConfigFromEnv(env);

    // Then: the feature remains disabled and reports actionable diagnostics.
    expect(config.enabled).toBe(false);
    expect(config.diagnostics).toEqual([
      "HENT_AI_CONVERSATION_RAW_RETENTION_DAYS must be a positive integer",
      "HENT_AI_CONVERSATION_MAX_DELAY_MS must be greater than or equal to HENT_AI_CONVERSATION_MIN_DELAY_MS",
      "HENT_AI_CONVERSATION_RECENT_TURNS must be a positive integer",
      "HENT_AI_CONVERSATION_CONTEXT_REFRESH must be one of true,false,1,0,yes,no,on,off",
      "HENT_AI_CONVERSATION_PER_CHAR_MS must be a non-negative integer",
      "HENT_AI_CONVERSATION_MAX_DELIVERY_ATTEMPTS must be a positive integer",
    ]);
  });

  it("enables conversation only when every service env override is valid", () => {
    // Given: every supported conversation env override is valid.
    const env = {
      HENT_AI_CONVERSATION_ENABLED: "1",
      HENT_AI_CONVERSATION_RAW_RETENTION_DAYS: "30",
      HENT_AI_CONVERSATION_MIN_DELAY_MS: "750",
      HENT_AI_CONVERSATION_MAX_DELAY_MS: "3000",
      HENT_AI_CONVERSATION_MAX_CHUNKS: "6",
      HENT_AI_CONVERSATION_MAX_CHUNK_CHARS: "160",
      HENT_AI_CONVERSATION_COOLDOWN_MS: "10",
      HENT_AI_CONVERSATION_BUDGET_PER_HOUR: "7",
      HENT_AI_CONVERSATION_MIN_HUMAN_IDLE_MS: "20",
      HENT_AI_CONVERSATION_CONFIDENCE_THRESHOLD: "0.82",
      HENT_AI_CONVERSATION_PERSONA: "Speak warmly.",
      HENT_AI_CONVERSATION_RECENT_TURNS: "32",
      HENT_AI_CONVERSATION_CONTEXT_REFRESH: "off",
      HENT_AI_CONVERSATION_COMPACTION_INTERVAL_MS: "9000",
      HENT_AI_CONVERSATION_DEFAULT_CHANNEL_ENABLED: "false",
      HENT_AI_CONVERSATION_BASE_PAUSE_MS: "111",
      HENT_AI_CONVERSATION_PER_CHAR_MS: "22",
      HENT_AI_CONVERSATION_MAX_DELIVERY_ATTEMPTS: "4",
    };

    // When: the service loads conversation config.
    const config = loadConversationConfigFromEnv(env);

    // Then: opt-in succeeds without invoking any provider or network boundary.
    expect(config).toMatchObject({
      enabled: true,
      rawRetentionDays: 30,
      minDelayMs: 750,
      maxDelayMs: 3000,
      maxChunks: 6,
      maxChunkChars: 160,
      cooldownMs: 10,
      budgetPerHour: 7,
      minHumanIdleMs: 20,
      confidenceThreshold: 0.82,
      persona: "Speak warmly.",
      recentTurnWindow: 32,
      contextRefreshEnabled: false,
      compactionIntervalMs: 9000,
      defaultChannelEnabled: false,
      basePauseMs: 111,
      perCharMs: 22,
      maxDeliveryAttempts: 4,
      diagnostics: [],
    });
  });
});
