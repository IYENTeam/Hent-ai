import {
  EMOTIONS,
  DEFAULT_EMOTION as SHARED_DEFAULT_EMOTION,
  EMOTION_LABELS as SHARED_EMOTION_LABELS,
} from "@hent-ai/shared";

export type Emotion = "happy" | "neutral" | "loyalty" | "sorry" | "confused" | "focused";

export const VALID_EMOTIONS: Emotion[] = EMOTIONS as unknown as Emotion[];

export interface EmotionState {
  emotion: Emotion;
  timestamp: number;
  preview: string;
}

export interface EmotionRule {
  emotion: Emotion;
  patterns: RegExp[];
}

export const DEFAULT_EMOTION: Emotion = SHARED_DEFAULT_EMOTION as Emotion;

export const EMOTION_LABELS: Record<Emotion, string> = SHARED_EMOTION_LABELS as Record<Emotion, string>;
