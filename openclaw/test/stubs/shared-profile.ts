export type Emotion = "happy" | "neutral" | "loyalty" | "sorry" | "confused" | "focused";

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
