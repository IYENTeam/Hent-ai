import type { ProfileMode } from "./emotions.js";

export type { ProfileMode };

export interface Profile {
  id: string;
  name: string;
  character: string | null;
  soulSnippet: string | null;
  chatPrompt: string | null;
  mode: ProfileMode;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileCreateInput {
  id: string;
  name: string;
  character?: string;
  soulSnippet?: string;
  chatPrompt?: string;
  mode?: ProfileMode;
  model?: string;
}

export interface ProfileUpdateInput {
  name?: string;
  character?: string | null;
  soulSnippet?: string | null;
  chatPrompt?: string | null;
  mode?: ProfileMode;
  model?: string | null;
}

export interface ChannelProfileMapping {
  channelId: string;
  profileId: string;
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
