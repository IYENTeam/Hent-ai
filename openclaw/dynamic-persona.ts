import type { ProfileDatabase } from "@hent-ai/shared/db";
import type { Profile } from "@hent-ai/shared/profile";

const PERSONA_SEPARATOR = "\n\n--- Hent-ai Character ---\n";

export function buildDynamicPrompt(
  basePrompt: string,
  soulSnippet: string | null | undefined,
): string {
  if (!soulSnippet?.trim()) return basePrompt;
  return basePrompt + PERSONA_SEPARATOR + soulSnippet.trim();
}

function resolveProfile(
  db: ProfileDatabase,
  channelId: string | undefined,
  defaultProfileId: string | undefined,
): Profile | null {
  let profileId: string | null = null;
  if (channelId) {
    profileId = db.getChannelProfile(channelId);
  }
  if (!profileId) {
    profileId = defaultProfileId ?? null;
  }
  if (!profileId) return null;
  return db.getProfile(profileId);
}

export function getSoulSnippetForChannel(
  db: ProfileDatabase,
  channelId: string | undefined,
  defaultProfileId: string | undefined,
): string | null {
  const profile = resolveProfile(db, channelId, defaultProfileId);
  if (!profile) return null;
  if (profile.mode === "date") return profile.chatPrompt ?? profile.soulSnippet ?? null;
  return profile.soulSnippet ?? null;
}

export function getProfileModeForChannel(
  db: ProfileDatabase,
  channelId: string | undefined,
  defaultProfileId: string | undefined,
): string {
  const profile = resolveProfile(db, channelId, defaultProfileId);
  return profile?.mode ?? "default";
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
