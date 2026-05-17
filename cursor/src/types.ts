export type Emotion = "happy" | "neutral" | "loyalty" | "sorry" | "confused" | "focused";

export const VALID_EMOTIONS: Emotion[] = ["happy", "neutral", "loyalty", "sorry", "confused", "focused"];

export interface EmotionState {
  emotion: Emotion;
  timestamp: number;
  preview: string;
}

export interface EmotionRule {
  emotion: Emotion;
  patterns: RegExp[];
}

export const DEFAULT_EMOTION: Emotion = "neutral";

export const EMOTION_LABELS: Record<Emotion, string> = {
  happy: "완료!",
  neutral: "평온",
  loyalty: "알겠습니다",
  sorry: "죄송...",
  confused: "음...",
  focused: "분석 중...",
};
