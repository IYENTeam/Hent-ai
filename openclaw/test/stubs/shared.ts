export const EMOTIONS = ["happy", "neutral", "loyalty", "sorry", "confused", "focused"] as const;
export type Emotion = (typeof EMOTIONS)[number];
