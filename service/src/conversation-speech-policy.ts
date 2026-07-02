import type { ConversationServiceConfig } from "./conversation-config.js";
import { GENERIC_CONVERSATION_PERSONA, resolvePersonaText } from "./conversation-persona.js";

export { GENERIC_CONVERSATION_PERSONA };

export type ConversationSuppressedReason =
  | "service_disabled"
  | "channel_disabled"
  | "privacy_blocked"
  | "thread_blocked"
  | "duplicate_turn"
  | "self_echo"
  | "cooldown"
  | "hourly_budget_exhausted"
  | "no_recent_human_activity"
  | "recent_human_active"
  | "low_confidence";

export type ConversationPersonaSource = "channel_profile" | "config" | "generic";

export type ConversationPolicyPersona = {
  readonly source: ConversationPersonaSource;
  readonly text: string;
};

export type ConversationSpeechPolicyResult =
  | {
      readonly allowed: true;
      readonly persona: ConversationPolicyPersona;
      readonly budgetRemaining: number;
    }
  | {
      readonly allowed: false;
      readonly suppressedReason: ConversationSuppressedReason;
    };

export type ConversationPolicyChannel = {
  readonly enabled: boolean | null;
};

export type ConversationPolicyProfile = {
  readonly soulSnippet: string | null;
};

export type ConversationPolicyState = {
  readonly lastSpeechAtMs: number | null;
  readonly speechCountThisHour: number;
  readonly lastHumanMessageAtMs: number | null;
};

export type ConversationPolicyProviderDecision = {
  readonly confidence: number;
};

export type ConversationPolicySafeguards = {
  readonly privacyAllowed: boolean;
  readonly threadAllowed: boolean;
  readonly duplicateTurn: boolean;
  readonly selfEcho: boolean;
};

export type ConversationSpeechPolicyInput = {
  readonly config: ConversationServiceConfig;
  readonly channel: ConversationPolicyChannel;
  readonly profile?: ConversationPolicyProfile | undefined;
  readonly state: ConversationPolicyState;
  readonly provider: ConversationPolicyProviderDecision;
  readonly safeguards: ConversationPolicySafeguards;
  readonly nowMs: number;
};

export function evaluateConversationSpeechPolicy(input: ConversationSpeechPolicyInput): ConversationSpeechPolicyResult {
  const suppressedReason = suppressedReasonFor(input);
  if (suppressedReason) return { allowed: false, suppressedReason };

  return {
    allowed: true,
    persona: resolveConversationPersona(input),
    budgetRemaining: Math.max(0, input.config.budgetPerHour - input.state.speechCountThisHour - 1),
  };
}

export function resolveConversationPersona(input: ConversationSpeechPolicyInput): ConversationPolicyPersona {
  return resolvePersonaText({ soulSnippet: input.profile?.soulSnippet ?? null, configPersona: input.config.persona });
}

function suppressedReasonFor(input: ConversationSpeechPolicyInput): ConversationSuppressedReason | null {
  if (!input.config.enabled) return "service_disabled";
  if (input.channel.enabled !== true) return "channel_disabled";
  if (!input.safeguards.privacyAllowed) return "privacy_blocked";
  if (!input.safeguards.threadAllowed) return "thread_blocked";
  if (input.safeguards.duplicateTurn) return "duplicate_turn";
  if (input.safeguards.selfEcho) return "self_echo";
  if (isCoolingDown(input)) return "cooldown";
  if (input.state.speechCountThisHour >= input.config.budgetPerHour) return "hourly_budget_exhausted";
  if (input.state.lastHumanMessageAtMs === null) return "no_recent_human_activity";
  if (input.nowMs - input.state.lastHumanMessageAtMs < input.config.minHumanIdleMs) return "recent_human_active";
  return input.provider.confidence < input.config.confidenceThreshold ? "low_confidence" : null;
}

function isCoolingDown(input: ConversationSpeechPolicyInput): boolean {
  return input.state.lastSpeechAtMs !== null && input.nowMs - input.state.lastSpeechAtMs < input.config.cooldownMs;
}
