import type { ConversationServiceConfig } from "./conversation-config.js";

export const GENERIC_CONVERSATION_PERSONA =
  "You are HentAI, a concise bot presence. Never claim to be human. Keep replies short, useful, and clearly bot-authored.";

export type ConversationSuppressedReason =
  | "service_disabled"
  | "channel_disabled"
  | "privacy_blocked"
  | "thread_blocked"
  | "duplicate_signal"
  | "self_nudge"
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
  readonly duplicateSignal: boolean;
  readonly selfNudge: boolean;
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

type PersonaCandidate = {
  readonly source: ConversationPersonaSource;
  readonly note: string;
};

const HUMAN_IDENTITY_CLAIM_PATTERNS = [
  /\b(?:i\s+am|i'm|im)\s+(?:a\s+|an\s+)?(?:(?:actual|living|real)\s+)?(?:human(?:\s+being)?|person)\b[,.! ]*/gi,
  /\b(?:i\s+am|i'm|im)\s+not\s+(?:a\s+|an\s+)?(?:ai|artificial\s+intelligence|bot|robot)\b[,.! ]*/gi,
  /\b(?:not|never)\s+(?:a\s+|an\s+)?(?:ai|artificial\s+intelligence|bot|robot)\b[,.! ]*/gi,
  /\b(?:actual|living|real)\s+(?:human(?:\s+being)?|person)\b[,.! ]*/gi,
] as const;

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
  const profileNote = sanitizePersonaNote(input.profile?.soulSnippet);
  if (profileNote) return withPersonaBoundary({ source: "channel_profile", note: profileNote });

  const configNote = sanitizePersonaNote(input.config.persona);
  if (configNote) return withPersonaBoundary({ source: "config", note: configNote });

  return { source: "generic", text: GENERIC_CONVERSATION_PERSONA };
}

function suppressedReasonFor(input: ConversationSpeechPolicyInput): ConversationSuppressedReason | null {
  if (!input.config.enabled) return "service_disabled";
  if (input.channel.enabled !== true) return "channel_disabled";
  if (!input.safeguards.privacyAllowed) return "privacy_blocked";
  if (!input.safeguards.threadAllowed) return "thread_blocked";
  if (input.safeguards.duplicateSignal) return "duplicate_signal";
  if (input.safeguards.selfNudge) return "self_nudge";
  if (isCoolingDown(input)) return "cooldown";
  if (input.state.speechCountThisHour >= input.config.budgetPerHour) return "hourly_budget_exhausted";
  if (input.state.lastHumanMessageAtMs === null) return "no_recent_human_activity";
  if (input.nowMs - input.state.lastHumanMessageAtMs < input.config.minHumanIdleMs) return "recent_human_active";
  return input.provider.confidence < input.config.confidenceThreshold ? "low_confidence" : null;
}

function isCoolingDown(input: ConversationSpeechPolicyInput): boolean {
  return input.state.lastSpeechAtMs !== null && input.nowMs - input.state.lastSpeechAtMs < input.config.cooldownMs;
}

function withPersonaBoundary(candidate: PersonaCandidate): ConversationPolicyPersona {
  return {
    source: candidate.source,
    text: `You are HentAI, a concise bot presence. Never claim to be human. Persona notes: ${candidate.note}`,
  };
}

function sanitizePersonaNote(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const withoutIdentityClaims = HUMAN_IDENTITY_CLAIM_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, " "),
    trimmed,
  );
  const normalized = withoutIdentityClaims.replace(/\s+/g, " ").replace(/^[,.;:\s]+/g, "").trim();
  return normalized.length > 0 ? normalized : null;
}
