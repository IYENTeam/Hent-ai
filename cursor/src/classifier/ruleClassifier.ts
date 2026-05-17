import { Emotion, EmotionRule, DEFAULT_EMOTION, VALID_EMOTIONS } from "../types";
import { EMOTION_RULES as SHARED_RULES } from "@hent-ai/shared";

export const EMOTION_RULES: EmotionRule[] = SHARED_RULES as EmotionRule[];

export function detectEmotion(
  text: string,
  rules: EmotionRule[] = EMOTION_RULES,
  fallback: Emotion = DEFAULT_EMOTION,
): Emotion {
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return rule.emotion;
      }
    }
  }
  return fallback;
}

export function extractEmotion(raw: string | null | undefined): Emotion | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  const direct = VALID_EMOTIONS.find((e) => e === cleaned);
  if (direct) return direct;
  const found = VALID_EMOTIONS.find((e) => cleaned.includes(e));
  return found ?? null;
}
