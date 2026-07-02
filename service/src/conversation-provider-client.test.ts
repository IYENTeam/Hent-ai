import { describe, expect, it, vi } from "vitest";
import { CONVERSATION_CONTRACT_SCHEMAS } from "./conversation-contracts.js";
import { DEFAULT_CONVERSATION_CONFIG, type ConversationDecisionProvider } from "./conversation-config.js";
import { createLlmConversationDecisionProvider } from "./conversation-decision-provider.js";
import {
  createConversationProviderClient,
  loadConversationProviderConfigFromEnv,
  type ConversationProviderClient,
} from "./conversation-provider-client.js";

describe("conversation provider client", () => {
  it("posts OpenAI-compatible chat-completions prompts and returns message content", async () => {
    // Given: a configured OpenAI-compatible conversation provider.
    const calls: Array<{ readonly input: string; readonly init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "provider text" } }] }));
    };
    const client = createConversationProviderClient({
      endpoint: "https://provider.example/v1/chat/completions",
      token: "provider-token",
      model: "chat-model",
      timeoutMs: 20_000,
      extraHeaders: { "x-route": "conversation" },
      extraBody: { temperature: 0.2 },
      fetchImpl,
    });

    // When: the service asks for a completion.
    const text = await client.complete({ system: "Return JSON only.", user: "{\"hello\":true}" }, { model: "decision-model" });

    // Then: the provider receives a chat-completions request and the content is returned.
    expect(text).toBe("provider text");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://provider.example/v1/chat/completions");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer provider-token",
      "content-type": "application/json",
      "x-route": "conversation",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: "decision-model",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: "{\"hello\":true}" },
      ],
    });
  });

  it("fails closed when provider env is incomplete or responses are unusable", async () => {
    // Given: missing required provider env and a provider returning an invalid shape.
    const config = loadConversationProviderConfigFromEnv({
      HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "https://provider.example/v1/chat/completions",
      HENT_AI_CONVERSATION_PROVIDER_TOKEN: "provider-token",
    });
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 500 });
    const client = createConversationProviderClient({
      endpoint: "https://provider.example/v1/chat/completions",
      token: "provider-token",
      model: "chat-model",
      timeoutMs: 20_000,
      fetchImpl,
    });

    // When: env or the remote provider cannot produce valid content.
    const text = await client.complete({ system: "system", user: "user" });

    // Then: callers can omit the provider or fail closed without exceptions.
    expect(config).toBeNull();
    expect(text).toBeNull();
  });
});

describe("LLM conversation decision provider", () => {
  it("injects the resolved persona into the speech decision prompt and maps speak decisions", async () => {
    // Given: a provider client that returns a valid speech decision.
    const prompts: Array<{ readonly system: string; readonly user: string }> = [];
    const client: ConversationProviderClient = {
      complete: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          schema: CONVERSATION_CONTRACT_SCHEMAS.speechDecision,
          decision: "speak",
          reason: "A short answer would help.",
          confidence: 0.91,
          chunks: ["짧게 말하면 지금은 폴러 기반이 맞아."],
        });
      },
    };
    const provider: ConversationDecisionProvider = createLlmConversationDecisionProvider({
      client,
      model: "decision-model",
      resolvePersonaFor: () => ({
        source: "channel_profile",
        text: "You are HentAI. Persona notes: calm deployment guide.",
      }),
    });

    // When: the runtime asks the LLM whether to speak.
    const decision = await provider.decide({
      config: {
        ...DEFAULT_CONVERSATION_CONFIG,
        enabled: true,
        cooldownMs: 0,
        minHumanIdleMs: 0,
      },
      scope: { scopeId: "discord:c1", channelId: "c1" },
      recentTurns: [],
      memorySummaries: ["The room is discussing deployment timing."],
    });

    // Then: the persona is part of the user JSON and the speak decision is preserved.
    expect(decision).toEqual({
      kind: "speak",
      confidence: 0.91,
      chunks: ["짧게 말하면 지금은 폴러 기반이 맞아."],
      diagnostics: [],
    });
    expect(prompts[0]?.system).toContain(CONVERSATION_CONTRACT_SCHEMAS.speechDecision);
    expect(prompts[0]?.user).toContain("calm deployment guide");
    expect(prompts[0]?.user).toContain("The room is discussing deployment timing.");
  });

  it("maps malformed provider output to no_reply diagnostics", async () => {
    // Given: a provider client that cannot return contract JSON.
    const client: ConversationProviderClient = {
      complete: async () => "sure, I can talk",
    };
    const provider = createLlmConversationDecisionProvider({
      client,
      resolvePersonaFor: () => ({ source: "generic", text: "generic persona" }),
    });

    // When: the decision provider parses the malformed output.
    const decision = await provider.decide({
      config: {
        ...DEFAULT_CONVERSATION_CONFIG,
        enabled: true,
        cooldownMs: 0,
        minHumanIdleMs: 0,
      },
      scope: { scopeId: "discord:c1", channelId: "c1" },
      recentTurns: [],
      memorySummaries: [],
    });

    // Then: malformed output fails closed and surfaces the parser diagnostic.
    expect(decision).toMatchObject({
      kind: "no_reply",
      reason: "malformed_json",
      diagnostics: [{ code: "malformed_json" }],
    });
  });
});
