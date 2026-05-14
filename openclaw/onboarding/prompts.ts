import type { Emotion } from "./session.js";

const EMOTION_DESCRIPTORS: Record<Emotion, string> = {
  happy: "smiling brightly, giving a thumbs up, celebrating with joy",
  neutral: "calm and relaxed, default resting expression, at ease",
  loyalty: "saluting attentively, nodding with respect, ready to help",
  sorry: "looking apologetic, bowing slightly, sheepish expression",
  confused: "tilting head with a puzzled look, question mark above head",
  focused: "concentrating intensely, determined expression, working hard",
};

export function buildBasePrompt(character: string, feedback: string[]): string {
  let prompt = `${character}, standing in a neutral pose facing forward. Simple clean background, consistent art style, square format, high quality PNG. This is a character reference sheet — no extreme emotion, just the character clearly visible.`;
  if (feedback.length > 0) {
    prompt += ` Additional requirements: ${feedback.join(", ")}.`;
  }
  return prompt;
}

export function buildEmotionPrompt(
  character: string,
  emotion: Emotion,
  feedback: string[],
): string {
  let prompt = `${character}, expressing ${emotion}: ${EMOTION_DESCRIPTORS[emotion]}. Simple clean background, consistent art style, square format, high quality PNG.`;
  if (feedback.length > 0) {
    prompt += ` Additional requirements: ${feedback.join(", ")}.`;
  }
  return prompt;
}
