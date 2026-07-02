import type { ConversationServiceConfig } from "./conversation-config.js";
import type { ConversationPolicyPersona, ConversationPersonaSource } from "./conversation-speech-policy.js";
import type { ServiceDatabase } from "./db.js";

export const GENERIC_CONVERSATION_PERSONA =
  "You are HentAI, a concise bot presence. Never claim to be human. Keep replies short, useful, and clearly bot-authored.";

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

export function resolvePersonaText(input: {
  readonly soulSnippet: string | null;
  readonly configPersona?: string | undefined;
}): ConversationPolicyPersona {
  const profileNote = sanitizePersonaNote(input.soulSnippet);
  if (profileNote) return withPersonaBoundary({ source: "channel_profile", note: profileNote });

  const configNote = sanitizePersonaNote(input.configPersona);
  if (configNote) return withPersonaBoundary({ source: "config", note: configNote });

  return { source: "generic", text: GENERIC_CONVERSATION_PERSONA };
}

export function createConversationPersonaResolver(
  db: ServiceDatabase,
  config: ConversationServiceConfig,
): (channelId: string) => ConversationPolicyPersona {
  return (channelId) => {
    const mapping = db.getChannelMapping(channelId);
    const profile = mapping?.profileId ? db.getProfile(mapping.profileId) : null;
    return resolvePersonaText({ soulSnippet: profile?.soulSnippet ?? null, configPersona: config.persona });
  };
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
