import type {
  ConversationDecisionProvider,
  ConversationProviderDecision,
  ConversationServiceConfig,
} from "./conversation-config.js";
import { buildSpeechDecisionPrompt, parseSpeechDecisionResponse } from "./conversation-contracts.js";
import type { ConversationPolicyPersona } from "./conversation-speech-policy.js";
import type { ConversationProviderClient } from "./conversation-provider-client.js";

export type DecisionProviderDeps = {
  readonly client: ConversationProviderClient;
  readonly resolvePersonaFor: (channelId: string) => ConversationPolicyPersona;
  readonly model?: string;
};

export function createLlmConversationDecisionProvider(deps: DecisionProviderDeps): ConversationDecisionProvider {
  return {
    async decide(request) {
      const persona = deps.resolvePersonaFor(request.scope.channelId);
      const text = await deps.client.complete(buildSpeechDecisionPrompt({
        config: request.config,
        scope: request.scope,
        recentTurns: request.recentTurns,
        memorySummaries: request.memorySummaries,
        persona: persona.text,
      }), deps.model ? { model: deps.model } : undefined);
      return providerDecisionFromText(text, request.config);
    },
  };
}

function providerDecisionFromText(text: string | null, config: ConversationServiceConfig): ConversationProviderDecision {
  const parsed = parseSpeechDecisionResponse(text, config);
  if (parsed.kind === "no_reply") {
    return { kind: "no_reply", reason: parsed.reason, diagnostics: parsed.diagnostics };
  }
  switch (parsed.value.kind) {
    case "no_reply":
      return { kind: "no_reply", reason: parsed.value.reason, diagnostics: parsed.diagnostics };
    case "speak":
      return {
        kind: "speak",
        confidence: parsed.value.confidence,
        chunks: parsed.value.chunks,
        diagnostics: parsed.diagnostics,
      };
    default:
      return assertNeverDecision(parsed.value);
  }
}

function assertNeverDecision(value: never): never {
  throw new Error(`Unhandled conversation decision: ${String(value)}`);
}
