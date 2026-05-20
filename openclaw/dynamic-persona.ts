import type { ProfileDatabase } from "@hent-ai/shared/db";

const PERSONA_SEPARATOR = "\n\n--- Hent-ai Character ---\n";

export function buildDynamicPrompt(
  basePrompt: string,
  soulSnippet: string | null | undefined,
): string {
  if (!soulSnippet?.trim()) return basePrompt;
  return basePrompt + PERSONA_SEPARATOR + soulSnippet.trim();
}

export function getSoulSnippetForChannel(
  db: ProfileDatabase,
  channelId: string | undefined,
  defaultProfileId: string | undefined,
): string | null {
  if (!channelId && !defaultProfileId) return null;

  let profileId: string | null = null;
  if (channelId) {
    profileId = db.getChannelProfile(channelId);
  }
  if (!profileId) {
    profileId = defaultProfileId ?? null;
  }
  if (!profileId) return null;

  const profile = db.getProfile(profileId);
  return profile?.soulSnippet ?? null;
}

export function appendPersonaToPrompt(
  basePrompt: string,
  db: ProfileDatabase,
  channelId: string | undefined,
  defaultProfileId: string | undefined,
): string {
  const snippet = getSoulSnippetForChannel(db, channelId, defaultProfileId);
  return buildDynamicPrompt(basePrompt, snippet);
}
