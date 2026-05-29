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

export type Emotion = "happy" | "neutral" | "loyalty" | "sorry" | "confused" | "focused";

export interface ChannelProfileMapping {
  channelId: string;
  profileId: string;
}

export interface ChannelSettings {
  channelId: string;
  enabled: boolean | null;
  assetSetId: string | null;
}

export interface HentProfile {
  name: string;
  description: string;
  emotions: Record<Emotion, string>;
}

export const DEFAULT_HENT_PROFILE: HentProfile = {
  name: "default",
  description: "test profile",
  emotions: {
    happy: "happy",
    neutral: "neutral",
    loyalty: "loyalty",
    sorry: "sorry",
    confused: "confused",
    focused: "focused",
  },
};


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
