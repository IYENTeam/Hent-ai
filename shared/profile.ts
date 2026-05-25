export interface Profile {
  id: string;
  name: string;
  character: string | null;
  soulSnippet: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileCreateInput {
  id: string;
  name: string;
  character?: string;
  soulSnippet?: string;
  model?: string;
}

export interface ProfileUpdateInput {
  name?: string;
  character?: string | null;
  soulSnippet?: string | null;
  model?: string | null;
}

export interface ChannelProfileMapping {
  channelId: string;
  profileId: string;
}

export interface ChannelSettings {
  channelId: string;
  enabled: boolean | null;
  assetSetId: string | null;
}

const MAX_PROFILE_ID_LENGTH = 64;

// lowercase alphanumeric, hyphens, underscores; must start with letter or digit
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Rejects empty, oversized, non-slug, and path-traversal IDs. */
export function validateProfileId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.length > MAX_PROFILE_ID_LENGTH) return false;
  if (id.includes("..") || id.includes("/") || id.includes("\\")) return false;
  return PROFILE_ID_RE.test(id);
}
