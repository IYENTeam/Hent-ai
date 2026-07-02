import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG } from "./conversation-config.js";
import { startupDiagnostics } from "./main.js";

describe("service main startup diagnostics", () => {
  it("reports every silent no-op condition before the server starts", () => {
    // Given: conversation is enabled but required runtime wiring is absent or invalid.
    const diagnostics = startupDiagnostics({
      conversationConfig: {
        ...DEFAULT_CONVERSATION_CONFIG,
        enabled: false,
        diagnostics: ["HENT_AI_CONVERSATION_MAX_DELAY_MS must be greater than or equal to HENT_AI_CONVERSATION_MIN_DELAY_MS"],
      },
      pollerConfig: null,
      providerConfigured: false,
      verifierConfigured: false,
      env: {
        HENT_AI_CONVERSATION_ENABLED: "true",
        HENT_AI_DISCORD_POLLER_TOKEN: "",
        HENT_AI_DISCORD_POLLER_CHANNELS: "",
      },
    });

    // When: startup diagnostics are prepared for logging.
    const messages = diagnostics.map((diagnostic) => `${diagnostic.level}:${diagnostic.message}`);

    // Then: each silent no-op has an explicit operator-facing log line.
    expect(messages).toEqual([
      "error:HENT_AI_CONVERSATION_MAX_DELAY_MS must be greater than or equal to HENT_AI_CONVERSATION_MIN_DELAY_MS; conversation disabled",
      "warn:conversation disabled due to invalid configuration",
      "warn:discord poller disabled: missing HENT_AI_DISCORD_POLLER_TOKEN, HENT_AI_DISCORD_POLLER_CHANNELS",
      "warn:HENT_AI_DISCORD_POLLER_BOT_USER_ID missing; self-message recognition is disabled",
      "warn:conversation provider missing; reply checks run as no_reply(missing_decision_provider)",
      "warn:final-response verifier missing; emotion verdict selection is disabled",
    ]);
  });
});
